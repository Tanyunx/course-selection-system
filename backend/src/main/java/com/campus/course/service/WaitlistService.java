package com.campus.course.service;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.config.AppProperties;
import com.campus.course.db.Db;

/**
 * 候补与自动递补（对应设计文档 4.6、6.2，等价于原 Node 版的 services/waitlistService.js）。
 *
 * <h2>递补规则</h2>
 * <ol>
 *   <li>取该开课候补队列中状态为「候补中」且 queue_no 最小的一名学生；</li>
 *   <li>对该生重新执行完整的选课校验（批次、容量、时间冲突、学分、先修）；</li>
 *   <li>校验通过：生成选课记录（来源标记为「候补递补」）、占用名额、候补记录置为「已递补」，
 *       发送通知并设置确认截止时间；</li>
 *   <li>校验不通过：候补记录置为「已失效」，发送「候补失败」通知，继续顺延下一名；</li>
 *   <li>确认截止前未确认（{@link #sweepExpired} 定时扫描）则释放名额并继续顺延。</li>
 * </ol>
 *
 * <p>每一步都在独立事务中完成，并对开课行与候补行加 {@code FOR UPDATE}，
 * 保证多个人同时退课时不会把同一个候补名额发给两个人。
 */
@Service
public class WaitlistService {

    private static final Logger log = LoggerFactory.getLogger(WaitlistService.class);

    public static final int WAITING = 1;
    public static final int PROMOTED = 2;
    public static final int CANCELED = 3;
    public static final int INVALID = 4;

    /** 单次递补最多尝试的候选人数，避免一个异常队列把请求拖死 */
    private static final int MAX_ITER = 20;

    private final Db db;
    private final RuleService rules;
    private final NoticeService notice;
    private final AuditService audit;
    private final int confirmHours;

    public WaitlistService(Db db, RuleService rules, NoticeService notice,
                           AuditService audit, AppProperties props) {
        this.db = db;
        this.rules = rules;
        this.notice = notice;
        this.audit = audit;
        this.confirmHours = props.getBusiness().getWaitlistConfirmHours();
    }

    /* ------------------------------------------------------------------ */
    /* 加入 / 取消 / 确认                                                    */
    /* ------------------------------------------------------------------ */

    public Map<String, Object> join(Map<String, Object> student, long offeringId) {
        Map<String, Object> term = rules.getCurrentTerm();
        long termId = Db.num(term, "id");
        long studentId = Db.num(student, "id");

        Map<String, Object> offering = db.queryOne("""
                SELECT o.*, c.name AS course_name, c.course_code, c.credit
                  FROM t_course_offering o JOIN t_course c ON c.id = o.course_id
                 WHERE o.id = ?
                """, offeringId);
        if (offering == null || Db.num(offering, "term_id") != termId) {
            throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
        }
        rules.assertInBatch(termId, student);

        Map<String, Object> selected = db.queryOne(
                "SELECT status FROM t_enrollment WHERE student_id = ? AND offering_id = ? AND status = 1",
                studentId, offeringId);
        if (selected != null) {
            throw new BizException(ErrorCode.DUPLICATE_ENROLL);
        }

        Map<String, Object> exist = db.queryOne(
                "SELECT * FROM t_waitlist WHERE student_id = ? AND offering_id = ?",
                studentId, offeringId);
        if (exist != null && Db.num(exist, "status") == WAITING) {
            throw new BizException(ErrorCode.DUPLICATE_WAITLIST,
                    "你已加入候补，当前排位为第 " + Db.num(exist, "queue_no") + " 位",
                    Map.of("queueNo", Db.num(exist, "queue_no")));
        }
        if (exist != null && Db.num(exist, "status") == PROMOTED) {
            throw new BizException(ErrorCode.DUPLICATE_ENROLL, "你已通过候补递补获得该课程名额");
        }

        // 先修校验：不满足者不允许进入候补队列（递补时会再次校验）
        rules.assertPrereqSatisfied(studentId, Db.num(offering, "course_id"));

        long queueNo = db.withTransaction(() -> {
            // PostgreSQL 不允许 FOR UPDATE 与聚合函数同时出现
            // （MySQL 允许，这正是 MySQL → PostgreSQL 迁移时的一个坑：
            //   SELECT MAX(...) ... FOR UPDATE 在 PG 下报 0A000 feature_not_supported）。
            // 等价改法：先把「开课」这一行锁住，同一门课的候补入队因此被串行化，
            // 行锁一直持有到事务提交，之后再取 MAX(queue_no) 就不可能出现两个并发请求
            // 拿到同一个排位号。
            db.queryOne("SELECT id FROM t_course_offering WHERE id = ? FOR UPDATE", offeringId);
            Map<String, Object> row = db.queryOne(
                    "SELECT COALESCE(MAX(queue_no), 0) AS max_no FROM t_waitlist WHERE offering_id = ?",
                    offeringId);
            long nextNo = (row == null ? 0 : Db.num(row, "max_no")) + 1;
            db.update("""
                    INSERT INTO t_waitlist (student_id, offering_id, queue_no, join_time, status)
                    VALUES (?, ?, ?, NOW(), 1)
                    ON CONFLICT (student_id, offering_id)
                    DO UPDATE SET queue_no = EXCLUDED.queue_no, join_time = NOW(),
                                  status = 1, expire_time = NULL
                    """, studentId, offeringId, nextNo);
            return nextNo;
        });

        String courseName = Db.str(offering, "course_name");
        notice.send(Db.num(student, "user_id"), NoticeService.TYPE_WAITLIST_PROMOTED,
                "已加入候补",
                "你已加入《" + courseName + "》候补队列，当前排位第 " + queueNo
                        + " 位，名额释放后将按排位自动递补。",
                offeringId);
        audit.logSafe(null, "WAITLIST_JOIN", "OFFERING", offeringId, 1,
                "加入候补：" + courseName + "，排位 " + queueNo);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("offeringId", offeringId);
        result.put("courseName", courseName);
        result.put("queueNo", queueNo);
        result.put("queueCount", countWaiting(offeringId));
        return result;
    }

    public Map<String, Object> cancel(Map<String, Object> student, long offeringId) {
        Map<String, Object> row = db.queryOne(
                "SELECT * FROM t_waitlist WHERE student_id = ? AND offering_id = ?",
                Db.num(student, "id"), offeringId);
        if (row == null || Db.num(row, "status") != WAITING) {
            throw new BizException(ErrorCode.NOT_IN_WAITLIST);
        }
        db.update("UPDATE t_waitlist SET status = 3 WHERE id = ?", Db.num(row, "id"));
        audit.logSafe(null, "WAITLIST_CANCEL", "OFFERING", offeringId, 1, "取消候补");
        return Map.of("offeringId", offeringId, "queueNo", Db.num(row, "queue_no"));
    }

    public Map<String, Object> confirm(Map<String, Object> student, long offeringId) {
        Map<String, Object> row = db.queryOne(
                "SELECT * FROM t_waitlist WHERE student_id = ? AND offering_id = ?",
                Db.num(student, "id"), offeringId);
        if (row == null || Db.num(row, "status") != PROMOTED) {
            throw new BizException(ErrorCode.NOT_IN_WAITLIST, "你没有待确认的递补名额");
        }
        db.update("UPDATE t_waitlist SET expire_time = NULL WHERE id = ?", Db.num(row, "id"));
        audit.logSafe(null, "WAITLIST_CONFIRM", "OFFERING", offeringId, 1, "确认候补递补名额");
        return Map.of("offeringId", offeringId, "confirmed", true);
    }

    /* ------------------------------------------------------------------ */
    /* 我的候补                                                            */
    /* ------------------------------------------------------------------ */

    public List<Map<String, Object>> mine(Map<String, Object> student, long termId) {
        long studentId = Db.num(student, "id");
        List<Map<String, Object>> rows = db.query("""
                SELECT w.id, w.offering_id, w.queue_no, w.join_time, w.status, w.expire_time,
                       c.course_code, c.name AS course_name, c.credit, cat.name AS category_name,
                       o.capacity, o.enrolled, o.status AS offering_status, o.campus,
                       tu.real_name AS teacher_name
                  FROM t_waitlist w
                  JOIN t_course_offering o ON o.id = w.offering_id AND o.term_id = ?
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_course_category cat ON cat.id = c.category_id
                  JOIN t_teacher t ON t.id = o.teacher_id
                  JOIN t_user tu ON tu.id = t.user_id
                 WHERE w.student_id = ? AND w.status IN (1, 2)
                 ORDER BY w.join_time
                """, termId, studentId);
        if (rows.isEmpty()) {
            return rows;
        }

        List<Long> offeringIds = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            offeringIds.add(Db.num(r, "offering_id"));
        }
        Map<Long, Long> waitingCount = new LinkedHashMap<>();
        for (Map<String, Object> r : db.query("""
                SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist
                 WHERE offering_id IN (?) AND status = 1 GROUP BY offering_id
                """, offeringIds)) {
            waitingCount.put(Db.num(r, "offering_id"), Db.num(r, "cnt"));
        }
        Map<Long, Long> minQueue = new LinkedHashMap<>();
        for (Map<String, Object> r : db.query("""
                SELECT offering_id, MIN(queue_no) AS min_no FROM t_waitlist
                 WHERE offering_id IN (?) AND status = 1 GROUP BY offering_id
                """, offeringIds)) {
            minQueue.put(Db.num(r, "offering_id"), Db.num(r, "min_no"));
        }

        for (Map<String, Object> r : rows) {
            long offeringId = Db.num(r, "offering_id");
            long status = Db.num(r, "status");
            long queueNo = Db.num(r, "queue_no");
            r.put("heat", RuleService.heatOf(Db.num(r, "enrolled"), Db.num(r, "capacity")));
            r.put("waitingCount", waitingCount.getOrDefault(offeringId, 0L));
            r.put("aheadCount", status == 1
                    ? Math.max(0, queueNo - minQueue.getOrDefault(offeringId, queueNo))
                    : 0L);
            r.put("statusText", status == 1 ? "候补中" : "已递补");
        }
        return rows;
    }

    public long countWaiting(long offeringId) {
        Map<String, Object> r = db.queryOne(
                "SELECT COUNT(*) AS cnt FROM t_waitlist WHERE offering_id = ? AND status = 1",
                offeringId);
        return r == null ? 0 : Db.num(r, "cnt");
    }

    /* ------------------------------------------------------------------ */
    /* 自动递补                                                            */
    /* ------------------------------------------------------------------ */

    /** 递补过程记录 */
    private record Outcome(String action, Map<String, Object> detail, String stopReason) {
    }

    /**
     * 名额释放后的自动递补主流程。
     *
     * @return 递补过程记录，供前端与审计展示
     */
    public List<Map<String, Object>> promoteFromOffering(long offeringId) {
        List<Map<String, Object>> trace = new ArrayList<>();

        Map<String, Object> term = rules.getCurrentTerm();
        Map<String, Object> offering = db.queryOne("""
                SELECT o.*, c.name AS course_name, c.course_code, c.credit, c.id AS course_id
                  FROM t_course_offering o JOIN t_course c ON c.id = o.course_id
                 WHERE o.id = ?
                """, offeringId);
        if (offering == null || term == null) {
            return trace;
        }
        long termId = Db.num(term, "id");

        for (int i = 0; i < MAX_ITER; i++) {
            Outcome outcome = db.withTransaction(() -> promoteOnce(offeringId, termId, offering));
            if ("EMPTY".equals(outcome.action()) || "STOP".equals(outcome.action())) {
                if (outcome.stopReason() != null) {
                    log.debug("候补递补停止 offering={} reason={}", offeringId, outcome.stopReason());
                }
                return trace;
            }
            trace.add(outcome.detail());
            if ("PROMOTED".equals(outcome.action())) {
                return trace;
            }
        }
        log.warn("候补递补达到单次处理上限 offering={}", offeringId);
        return trace;
    }

    /** 单轮递补：对队首候选重新执行完整选课校验，通过则占名额并落库。 */
    private Outcome promoteOnce(long offeringId, long termId, Map<String, Object> offering) {
        Map<String, Object> off = db.queryOne(
                "SELECT * FROM t_course_offering WHERE id = ? FOR UPDATE", offeringId);
        if (off == null || Db.num(off, "status") == 0 || Db.num(off, "enrolled") >= Db.num(off, "capacity")) {
            return new Outcome("STOP", null, "名额已被占满或开课已停开");
        }

        Map<String, Object> cand = db.queryOne("""
                SELECT * FROM t_waitlist WHERE offering_id = ? AND status = 1
                 ORDER BY queue_no LIMIT 1 FOR UPDATE
                """, offeringId);
        if (cand == null) {
            return new Outcome("EMPTY", null, null);
        }

        Map<String, Object> student = db.queryOne("""
                SELECT s.*, u.id AS uid, u.real_name
                  FROM t_student s JOIN t_user u ON u.id = s.user_id
                 WHERE s.id = ?
                """, Db.num(cand, "student_id"));
        if (student == null) {
            db.update("UPDATE t_waitlist SET status = 4 WHERE id = ?", Db.num(cand, "id"));
            return new Outcome("INVALID", invalidDetail(cand, null, "学生档案不存在", 0), null);
        }

        String courseName = Db.str(offering, "course_name");
        try {
            Map<String, Object> batch = rules.assertInBatch(termId, student);
            RuleService.ConflictResult conflict = rules.detectConflict(
                    offeringId, Db.num(student, "id"), termId);
            if (!conflict.conflicts().isEmpty()) {
                throw new BizException(ErrorCode.TIME_CONFLICT,
                        "与已选课程时间冲突：" + EnrollmentService.conflictText(conflict.conflicts()),
                        Map.of("conflicts", conflict.conflicts()));
            }
            rules.assertCreditNotExceed(Db.num(student, "id"), termId,
                    Db.str(student, "grade"), Db.decimal(offering, "credit"), null);
            rules.assertPrereqSatisfied(Db.num(student, "id"), Db.num(offering, "course_id"));

            // 校验通过：占名额（条件更新，仍可能被抢占）、生成选课记录、置为已递补
            int updated = db.update("""
                    UPDATE t_course_offering SET enrolled = enrolled + 1
                     WHERE id = ? AND enrolled < capacity AND status <> 0
                    """, offeringId);
            if (updated == 0) {
                return new Outcome("STOP", null, "名额已被抢占");
            }
            db.update("""
                    UPDATE t_course_offering SET status = 2
                     WHERE id = ? AND status = 1 AND enrolled >= capacity
                    """, offeringId);

            db.update("""
                    INSERT INTO t_enrollment (student_id, offering_id, select_time, status, source, drop_time)
                    VALUES (?, ?, NOW(), 1, 2, NULL)
                    ON CONFLICT (student_id, offering_id)
                    DO UPDATE SET status = 1, select_time = NOW(), source = 2, drop_time = NULL
                    """, Db.num(student, "id"), offeringId);

            Timestamp expire = new Timestamp(System.currentTimeMillis() + confirmHours * 3600L * 1000L);
            db.update("UPDATE t_waitlist SET status = 2, expire_time = ? WHERE id = ?",
                    expire, Db.num(cand, "id"));

            notice.send(Db.num(student, "user_id"), NoticeService.TYPE_WAITLIST_PROMOTED,
                    "候补递补成功",
                    "你候补的《" + courseName + "》已递补成功，请于 " + RuleService.fmt(expire) + " 前确认。",
                    offeringId);

            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("action", "PROMOTED");
            detail.put("studentNo", student.get("student_no"));
            detail.put("studentName", student.get("real_name"));
            detail.put("queueNo", Db.num(cand, "queue_no"));
            detail.put("batch", batch.get("name"));
            detail.put("expireTime", expire);
            return new Outcome("PROMOTED", detail, null);
        } catch (BizException e) {
            // 校验不通过：置为已失效，发送通知，继续顺延下一名
            db.update("UPDATE t_waitlist SET status = 4 WHERE id = ?", Db.num(cand, "id"));
            notice.send(Db.num(student, "user_id"), NoticeService.TYPE_WAITLIST_FAILED,
                    "候补递补失败",
                    "你候补的《" + courseName + "》本次递补未通过校验（" + e.getMessage()
                            + "），名额已顺延下一位。",
                    offeringId);
            return new Outcome("INVALID", invalidDetail(cand, student, e.getMessage(), e.getCode()), null);
        }
    }

    private static Map<String, Object> invalidDetail(Map<String, Object> cand,
                                                     Map<String, Object> student,
                                                     String reason, int reasonCode) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("action", "INVALID");
        detail.put("studentNo", student == null ? null : student.get("student_no"));
        detail.put("studentName", student == null ? null : student.get("real_name"));
        detail.put("queueNo", Db.num(cand, "queue_no"));
        detail.put("reason", reason);
        detail.put("reasonCode", reasonCode);
        return detail;
    }

    /* ------------------------------------------------------------------ */
    /* 超时回收（4.6 第 5 条）                                              */
    /* ------------------------------------------------------------------ */

    /**
     * 定时扫描：确认截止时间已过仍未确认的递补记录，回收名额并继续顺延。
     *
     * @return 本次处理的记录数
     */
    public int sweepExpired() {
        List<Map<String, Object>> rows = db.query("""
                SELECT id, student_id, offering_id, queue_no FROM t_waitlist
                 WHERE status = 2 AND expire_time IS NOT NULL AND expire_time < NOW()
                """);
        for (Map<String, Object> r : rows) {
            long offeringId = Db.num(r, "offering_id");
            db.update("UPDATE t_waitlist SET status = 4 WHERE id = ?", Db.num(r, "id"));

            Map<String, Object> seat = db.queryOne("""
                    SELECT id FROM t_enrollment
                     WHERE student_id = ? AND offering_id = ? AND status = 1
                    """, Db.num(r, "student_id"), offeringId);
            if (seat != null) {
                db.update("UPDATE t_enrollment SET status = 0, drop_time = NOW() WHERE id = ?",
                        Db.num(seat, "id"));
                db.update("UPDATE t_course_offering SET enrolled = enrolled - 1 WHERE id = ? AND enrolled > 0",
                        offeringId);
                db.update("""
                        UPDATE t_course_offering SET status = 1
                         WHERE id = ? AND status = 2 AND enrolled < capacity
                        """, offeringId);
                promoteFromOffering(offeringId);
            }
        }
        return rows.size();
    }
}
