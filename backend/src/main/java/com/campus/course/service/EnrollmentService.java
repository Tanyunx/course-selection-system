package com.campus.course.service;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.db.Db;

/**
 * 选课核心业务
 * （对应设计文档 6.1 选课流程、6.2 退课流程、6.3 换课流程、6.5 并发一致性设计，
 *   等价于原 Node 版的 services/enrollmentService.js）。
 *
 * <h2>并发一致性（这是本模块最关键的部分）</h2>
 * <ol>
 *   <li><b>占名额只用条件更新</b>：{@code UPDATE t_course_offering SET enrolled = enrolled + 1
 *       WHERE id = ? AND enrolled < capacity AND status <> 0}。PostgreSQL 会对该行加写锁，
 *       并把"余量是否够"的判断和自增放在同一条语句里原子完成，因此 enrolled 永远不会超过
 *       capacity，余量也不会变成负数。受影响行数为 0 即表示已满，直接返回 2001，不做重试。</li>
 *   <li><b>占位先于校验</b>：先占名额再校验冲突/学分/先修，用于快速隔离并发竞争；
 *       若后续校验失败，整个事务回滚，已占的名额自动归还（不存在"占住不放"）。</li>
 *   <li><b>换课"先占后放"</b>：在同一个事务里先占目标课名额，再释放原课名额；
 *       任一步失败整体回滚，原课程与名额保持不变，对外返回 2009。</li>
 *   <li><b>写记录用 UPSERT</b>：唯一键 (student_id, offering_id) 冲突时复用原行并复位状态，
 *       保留历史记录（见表 15 说明），同时避免并发重复插入产生唯一键冲突报错。</li>
 * </ol>
 */
@Service
public class EnrollmentService {

    private final Db db;
    private final RuleService rules;
    private final NoticeService notice;
    private final AuditService audit;
    private final WaitlistService waitlist;

    public EnrollmentService(Db db, RuleService rules, NoticeService notice,
                             AuditService audit, WaitlistService waitlist) {
        this.db = db;
        this.rules = rules;
        this.notice = notice;
        this.audit = audit;
        this.waitlist = waitlist;
    }

    /* ------------------------------------------------------------------ */
    /* 基础操作                                                            */
    /* ------------------------------------------------------------------ */

    /** 取开课基础信息（含课程名、代码、学分）。 */
    public Map<String, Object> getOffering(long offeringId) {
        return db.queryOne("""
                SELECT o.*, c.name AS course_name, c.course_code, c.credit, c.id AS course_id
                  FROM t_course_offering o
                  JOIN t_course c ON c.id = o.course_id
                 WHERE o.id = ?
                """, offeringId);
    }

    /**
     * 条件更新占用名额（并发一致性的最终防线）。
     * 返回受影响行数：0 表示名额已满或已停开，调用方据此返回 2001。
     */
    public int occupySeat(long offeringId) {
        int affected = db.update("""
                UPDATE t_course_offering
                   SET enrolled = enrolled + 1
                 WHERE id = ? AND enrolled < capacity AND status <> 0
                """, offeringId);
        if (affected == 0) {
            throw new BizException(ErrorCode.CAPACITY_FULL, null, Map.of("offeringId", offeringId));
        }
        // 占满后把状态推进到"已满"，供列表页与前端按钮状态使用
        db.update("""
                UPDATE t_course_offering SET status = 2
                 WHERE id = ? AND status = 1 AND enrolled >= capacity
                """, offeringId);
        return affected;
    }

    /** 释放名额并恢复开课状态。 */
    public void releaseSeat(long offeringId) {
        db.update("UPDATE t_course_offering SET enrolled = enrolled - 1 WHERE id = ? AND enrolled > 0",
                offeringId);
        db.update("""
                UPDATE t_course_offering SET status = 1
                 WHERE id = ? AND status = 2 AND enrolled < capacity
                """, offeringId);
    }

    /**
     * 写入选课记录：唯一键冲突时复用该行（保留历史，见 5.3 表 15 说明）。
     * 对应 MySQL 的 {@code ON DUPLICATE KEY UPDATE}，PostgreSQL 用 {@code ON CONFLICT}。
     */
    public void upsertEnrollment(long studentId, long offeringId, int source) {
        db.update("""
                INSERT INTO t_enrollment (student_id, offering_id, select_time, status, source, drop_time)
                VALUES (?, ?, NOW(), 1, ?, NULL)
                ON CONFLICT (student_id, offering_id)
                DO UPDATE SET status = 1, select_time = NOW(), source = EXCLUDED.source, drop_time = NULL
                """, studentId, offeringId, source);
    }

    /** 冲突结果转文案。 */
    static String conflictText(List<Map<String, Object>> conflicts) {
        StringBuilder sb = new StringBuilder();
        for (Map<String, Object> c : conflicts) {
            if (sb.length() > 0) {
                sb.append('；');
            }
            sb.append('《').append(c.get("course_name")).append('》')
                    .append(CourseService.weekdayText((int) Db.num(c, "weekday"))).append(' ')
                    .append(Db.num(c, "start_period")).append('-').append(Db.num(c, "end_period"))
                    .append(" 节（").append(CourseService.parityText((int) Db.num(c, "parity"))).append('）');
        }
        return sb.toString();
    }

    /* ------------------------------------------------------------------ */
    /* 选课（6.1）                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 选课。校验顺序：鉴权（拦截器）→ 幂等（Guard）→ 批次 → 重复 → 容量占用
     * → 时间冲突 → 学分 → 先修 → 落库。
     */
    public Map<String, Object> enroll(Map<String, Object> student, long offeringId) {
        Map<String, Object> term = rules.getCurrentTerm();
        if (term == null) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "系统未配置当前学期");
        }
        long termId = Db.num(term, "id");
        long studentId = Db.num(student, "id");

        Map<String, Object> offering = getOffering(offeringId);
        if (offering == null || Db.num(offering, "term_id") != termId) {
            throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
        }
        if (Db.num(offering, "status") == 0) {
            throw new BizException(ErrorCode.OFFERING_CLOSED);
        }

        // 3) 批次准入
        Map<String, Object> batch = rules.assertInBatch(termId, student);

        // 4) 重复校验
        Map<String, Object> dup = db.queryOne(
                "SELECT status FROM t_enrollment WHERE student_id = ? AND offering_id = ?",
                studentId, offeringId);
        if (dup != null && Db.num(dup, "status") == 1) {
            throw new BizException(ErrorCode.DUPLICATE_ENROLL);
        }
        Map<String, Object> wl = db.queryOne(
                "SELECT queue_no FROM t_waitlist WHERE student_id = ? AND offering_id = ? AND status = 1",
                studentId, offeringId);
        if (wl != null) {
            throw new BizException(ErrorCode.DUPLICATE_WAITLIST,
                    "你已加入候补，当前排位为第 " + Db.num(wl, "queue_no") + " 位",
                    Map.of("queueNo", Db.num(wl, "queue_no")));
        }

        BigDecimal credit = Db.decimal(offering, "credit");
        long courseId = Db.num(offering, "course_id");
        final List<Map<String, Object>> tightTransfers = new ArrayList<>();

        RuleService.CreditCheck creditCheck = db.withTransaction(() -> {
            // 5) 条件更新占名额
            occupySeat(offeringId);

            // 6) 时间冲突
            RuleService.ConflictResult conflict =
                    rules.detectConflict(offeringId, studentId, termId);
            if (!conflict.conflicts().isEmpty()) {
                throw new BizException(ErrorCode.TIME_CONFLICT,
                        "与已选课程时间冲突：" + conflictText(conflict.conflicts()),
                        Map.of("conflicts", conflict.conflicts()));
            }

            // 7) 学分
            RuleService.CreditCheck check = rules.assertCreditNotExceed(
                    studentId, termId, Db.str(student, "grade"), credit, BigDecimal.ZERO);

            // 8) 先修
            rules.assertPrereqSatisfied(studentId, courseId);

            // 9) 写入选课记录
            upsertEnrollment(studentId, offeringId, 1);

            // 赶课提示（同一天相邻节次但校区不同，不阻止选课，只作提醒）
            for (Map<String, Object> t : conflict.tightTransfers()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("courseName", t.get("course_name"));
                m.put("text", CourseService.weekdayText((int) Db.num(t, "weekday")) + " "
                        + Db.num(t, "end_period") + " 节与《" + t.get("course_name") + "》"
                        + Db.num(t, "other_start_period") + " 节相邻且分处 "
                        + t.get("campus") + "/" + t.get("other_campus"));
                tightTransfers.add(m);
            }
            return check;
        });

        String courseName = Db.str(offering, "course_name");
        String courseCode = Db.str(offering, "course_code");
        notice.send(Db.num(student, "user_id"), NoticeService.TYPE_ENROLL_RESULT,
                "选课成功",
                "你已成功选修《" + courseName + "》（" + courseCode + "），"
                        + RuleService.plain(credit) + " 学分。",
                offeringId);
        audit.log("ENROLL", "OFFERING", offeringId, 1,
                "选课成功：" + courseName + "；批次=" + batch.get("name"));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("offeringId", offeringId);
        result.put("courseName", courseName);
        result.put("batch", Map.of("id", Db.num(batch, "id"), "name", batch.get("name")));
        result.put("credit", creditPayload(creditCheck));
        result.put("tightTransfers", tightTransfers);
        return result;
    }

    private static Map<String, Object> creditPayload(RuleService.CreditCheck check) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("maxCredit", check == null ? null : check.maxCredit());
        m.put("willTotal", check == null ? null : check.willTotal());
        m.put("currentCredit", check == null ? null : check.currentCredit());
        return m;
    }

    /* ------------------------------------------------------------------ */
    /* 退课（6.2）                                                          */
    /* ------------------------------------------------------------------ */

    public Map<String, Object> drop(Map<String, Object> student, long offeringId) {
        Map<String, Object> term = rules.getCurrentTerm();
        long termId = Db.num(term, "id");
        long studentId = Db.num(student, "id");

        Map<String, Object> offering = getOffering(offeringId);
        if (offering == null || Db.num(offering, "term_id") != termId) {
            throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
        }

        // 退课截止校验
        Timestamp deadline = rules.assertDropAllowed(termId);

        db.inTransaction(() -> {
            Map<String, Object> row = db.queryOne(
                    "SELECT * FROM t_enrollment WHERE student_id = ? AND offering_id = ? FOR UPDATE",
                    studentId, offeringId);
            if (row == null || Db.num(row, "status") != 1) {
                throw new BizException(ErrorCode.NOT_ENROLLED);
            }
            db.update("UPDATE t_enrollment SET status = 0, drop_time = NOW() WHERE id = ?",
                    Db.num(row, "id"));
            releaseSeat(offeringId);
        });

        String courseName = Db.str(offering, "course_name");
        notice.send(Db.num(student, "user_id"), NoticeService.TYPE_DROP_RESULT,
                "退课已生效",
                "你已退选《" + courseName + "》（" + Db.str(offering, "course_code") + "），名额已释放。",
                offeringId);
        audit.log("DROP", "OFFERING", offeringId, 1, "退课成功：" + courseName);

        // 触发候补递补（事务外执行，避免长事务占住行锁）
        List<Map<String, Object>> promoted = waitlist.promoteFromOffering(offeringId);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("offeringId", offeringId);
        result.put("courseName", courseName);
        result.put("deadline", deadline);
        result.put("promoted", promoted);
        return result;
    }

    /* ------------------------------------------------------------------ */
    /* 换课（6.3，单一事务"先占后放"）                                        */
    /* ------------------------------------------------------------------ */

    public Map<String, Object> switchCourse(Map<String, Object> student,
                                            long fromOfferingId, long toOfferingId) {
        if (fromOfferingId == toOfferingId) {
            throw new BizException(ErrorCode.TARGET_NOT_SELECTABLE, "原课程与目标课程相同，无需换课");
        }
        Map<String, Object> term = rules.getCurrentTerm();
        long termId = Db.num(term, "id");
        long studentId = Db.num(student, "id");

        Map<String, Object> from = getOffering(fromOfferingId);
        Map<String, Object> to = getOffering(toOfferingId);
        if (from == null || to == null
                || Db.num(from, "term_id") != termId || Db.num(to, "term_id") != termId) {
            throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
        }
        if (Db.num(to, "status") == 0) {
            throw new BizException(ErrorCode.TARGET_NOT_SELECTABLE, "目标课程已停开");
        }

        Map<String, Object> batch = rules.assertInBatch(termId, student);

        BigDecimal toCredit = Db.decimal(to, "credit");
        BigDecimal fromCredit = Db.decimal(from, "credit");
        long toCourseId = Db.num(to, "course_id");

        try {
            db.inTransaction(() -> {
                // 1) 校验原选课记录并加行锁
                Map<String, Object> src = db.queryOne("""
                        SELECT * FROM t_enrollment
                         WHERE student_id = ? AND offering_id = ? AND status = 1 FOR UPDATE
                        """, studentId, fromOfferingId);
                if (src == null) {
                    throw new BizException(ErrorCode.NOT_ENROLLED, "你尚未选修原课程，无法换课");
                }

                // 2) 预占目标开课名额
                occupySeat(toOfferingId);

                // 3) 目标课程规则校验（冲突校验需排除即将释放的原课程）
                RuleService.ConflictResult conflict = rules.detectConflict(
                        toOfferingId, studentId, termId, fromOfferingId);
                if (!conflict.conflicts().isEmpty()) {
                    throw new BizException(ErrorCode.TIME_CONFLICT,
                            "目标课程与已选课程冲突：" + conflictText(conflict.conflicts()),
                            Map.of("conflicts", conflict.conflicts()));
                }
                rules.assertCreditNotExceed(studentId, termId, Db.str(student, "grade"),
                        toCredit, fromCredit);
                rules.assertPrereqSatisfied(studentId, toCourseId);

                // 4) 释放原开课名额
                db.update("UPDATE t_enrollment SET status = 0, drop_time = NOW() WHERE id = ?",
                        Db.num(src, "id"));
                releaseSeat(fromOfferingId);

                // 5) 写目标选课记录
                upsertEnrollment(studentId, toOfferingId, 1);
            });
        } catch (BizException e) {
            // 未选修原课程属于前置条件失败，原样抛出；其余失败统一折叠成 2009，
            // 告知"目标课程不可选，原课程未变动"，与原实现的对外语义一致
            if (e.getCode() == ErrorCode.NOT_ENROLLED) {
                throw e;
            }
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("reasonCode", e.getCode());
            data.put("reason", e.getMessage());
            if (e.getData() instanceof Map<?, ?> m) {
                m.forEach((k, v) -> data.put(String.valueOf(k), v));
            }
            throw new BizException(ErrorCode.TARGET_NOT_SELECTABLE,
                    "换课未生效：" + e.getMessage(), data);
        }

        String fromName = Db.str(from, "course_name");
        String toName = Db.str(to, "course_name");
        notice.send(Db.num(student, "user_id"), NoticeService.TYPE_ENROLL_RESULT,
                "换课成功", "已将《" + fromName + "》换为《" + toName + "》。", toOfferingId);
        audit.log("SWITCH", "OFFERING", toOfferingId, 1,
                "换课：" + fromName + " → " + toName + "；批次=" + batch.get("name"));

        List<Map<String, Object>> promoted = waitlist.promoteFromOffering(fromOfferingId);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("from", Map.of("offeringId", fromOfferingId, "courseName", fromName));
        result.put("to", Map.of("offeringId", toOfferingId, "courseName", toName));
        result.put("promoted", promoted);
        result.put("tightTransfers", List.of());
        return result;
    }

    /* ------------------------------------------------------------------ */
    /* 我的已选与课表                                                       */
    /* ------------------------------------------------------------------ */

    public List<Map<String, Object>> myEnrollments(Map<String, Object> student, long termId) {
        long studentId = Db.num(student, "id");
        List<Map<String, Object>> rows = db.query("""
                SELECT e.id AS enrollment_id, e.offering_id, e.select_time, e.source, e.status,
                       c.course_code, c.name AS course_name, c.credit, c.description,
                       cat.name AS category_name, cat.id AS category_id,
                       o.capacity, o.enrolled, o.campus, o.status AS offering_status,
                       tu.real_name AS teacher_name, t.title AS teacher_title
                  FROM t_enrollment e
                  JOIN t_course_offering o ON o.id = e.offering_id
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_course_category cat ON cat.id = c.category_id
                  JOIN t_teacher t ON t.id = o.teacher_id
                  JOIN t_user tu ON tu.id = t.user_id
                 WHERE e.student_id = ? AND o.term_id = ? AND e.status = 1
                 ORDER BY e.select_time
                """, studentId, termId);
        if (rows.isEmpty()) {
            return rows;
        }

        List<Long> ids = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            ids.add(Db.num(r, "offering_id"));
        }
        Map<Long, List<Map<String, Object>>> map = new LinkedHashMap<>();
        for (Map<String, Object> s : db.query(
                "SELECT * FROM t_course_schedule WHERE offering_id IN (?) ORDER BY weekday, start_period",
                ids)) {
            map.computeIfAbsent(Db.num(s, "offering_id"), k -> new ArrayList<>()).add(s);
        }

        for (Map<String, Object> r : rows) {
            List<Map<String, Object>> list = map.getOrDefault(Db.num(r, "offering_id"), List.of());
            List<String> texts = new ArrayList<>();
            List<String> places = new ArrayList<>();
            for (Map<String, Object> s : list) {
                texts.add(CourseService.scheduleText(s));
                String place = CourseService.joinNonBlank(" ",
                        Db.str(s, "campus"), Db.str(s, "building"), Db.str(s, "room"));
                if (!place.isEmpty()) {
                    places.add(place);
                }
            }
            r.put("schedules", list);
            r.put("scheduleText", texts);
            r.put("placeText", String.join(" / ", places));
            r.put("heat", RuleService.heatOf(Db.num(r, "enrolled"), Db.num(r, "capacity")));
        }
        return rows;
    }

    /** 我的课表（按周视图，支持单双周切换）。 */
    public Map<String, Object> timetable(Map<String, Object> student, long termId, Integer parity) {
        List<Map<String, Object>> list = myEnrollments(student, termId);
        List<Map<String, Object>> cells = new ArrayList<>();

        for (Map<String, Object> item : list) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> schedules = (List<Map<String, Object>>) item.get("schedules");
            for (Map<String, Object> s : schedules) {
                int p = (int) Db.num(s, "parity");
                // parity 为 1/2 时按单双周过滤：全周课程（parity=0）在任一视图都显示
                if (parity != null && parity != 0 && p != 0 && p != parity) {
                    continue;
                }
                Map<String, Object> cell = new LinkedHashMap<>();
                cell.put("offeringId", Db.num(item, "offering_id"));
                cell.put("courseName", item.get("course_name"));
                cell.put("courseCode", item.get("course_code"));
                cell.put("teacherName", item.get("teacher_name"));
                cell.put("credit", item.get("credit"));
                cell.put("categoryName", item.get("category_name"));
                cell.put("weekday", Db.num(s, "weekday"));
                cell.put("startPeriod", Db.num(s, "start_period"));
                cell.put("endPeriod", Db.num(s, "end_period"));
                cell.put("parity", p);
                cell.put("parityText", CourseService.parityText(p));
                cell.put("place", CourseService.joinNonBlank(" ",
                        Db.str(s, "campus"), Db.str(s, "building"), Db.str(s, "room")));
                cell.put("campus", s.get("campus"));
                cell.put("source", item.get("source"));
                cells.add(cell);
            }
        }

        // 冲突区域提示：正常流程下不应出现（选课时已拦截），这里作为兜底自检
        List<List<Object>> conflictCells = new ArrayList<>();
        for (int i = 0; i < cells.size(); i++) {
            for (int j = i + 1; j < cells.size(); j++) {
                Map<String, Object> a = cells.get(i);
                Map<String, Object> b = cells.get(j);
                int pa = (int) Db.num(a, "parity");
                int pb = (int) Db.num(b, "parity");
                boolean overlap = Db.num(a, "weekday") == Db.num(b, "weekday")
                        && Db.num(a, "startPeriod") <= Db.num(b, "endPeriod")
                        && Db.num(b, "startPeriod") <= Db.num(a, "endPeriod")
                        && !((pa == 1 && pb == 2) || (pa == 2 && pb == 1));
                if (overlap) {
                    conflictCells.add(List.of(Db.num(a, "offeringId"), Db.num(b, "offeringId")));
                }
            }
        }

        BigDecimal totalCredit = BigDecimal.ZERO;
        for (Map<String, Object> x : list) {
            totalCredit = totalCredit.add(Db.decimal(x, "credit"));
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("cells", cells);
        result.put("conflictCells", conflictCells);
        result.put("totalCredit", totalCredit);
        result.put("courseCount", list.size());
        return result;
    }
}
