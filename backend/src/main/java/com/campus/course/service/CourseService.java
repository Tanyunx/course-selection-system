package com.campus.course.service;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.stereotype.Service;

import com.campus.course.db.Db;
import com.campus.course.util.Period;

/**
 * 课程查询与状态标注服务
 * （对应设计文档 3.2.2 课程查询与浏览页、表 6 选课按钮状态，
 *   等价于原 Node 版的 services/courseService.js）。
 *
 * <p>性能要点：一页 10~50 条开课的状态标注不是逐行查库，而是用 5 条批量查询
 * （已选集合、候补集合、候补人数、冲突映射、先修满足情况）一次性算完。
 */
@Service
public class CourseService {

    private static final String[] WEEKDAY_TEXT =
            {"", "周一", "周二", "周三", "周四", "周五", "周六", "周日"};
    private static final Map<Integer, String> PARITY_TEXT =
            Map.of(0, "全周", 1, "单周", 2, "双周");

    private final Db db;
    private final RuleService rules;

    public CourseService(Db db, RuleService rules) {
        this.db = db;
        this.rules = rules;
    }

    public static String weekdayText(int n) {
        return n >= 1 && n <= 7 ? WEEKDAY_TEXT[n] : "";
    }

    public static String parityText(int n) {
        return PARITY_TEXT.getOrDefault(n, "全周");
    }

    /** 单个排课时段 → 可读文本，如「周一 第 1-2 节 08:00~09:25 · 东校区 一教 101」 */
    public static String scheduleText(Map<String, Object> s) {
        int weekday = (int) Db.num(s, "weekday");
        int start = (int) Db.num(s, "start_period");
        int end = (int) Db.num(s, "end_period");
        int parity = (int) Db.num(s, "parity");

        String parityStr = parity != 0 ? "（" + parityText(parity) + "）" : "";
        String place = joinNonBlank(" ",
                Db.str(s, "campus"), Db.str(s, "building"), Db.str(s, "room"));
        String time = Period.rangeText(start, end);
        return weekdayText(weekday) + " 第 " + start + "-" + end + " 节"
                + (time.isEmpty() ? "" : " " + time)
                + parityStr
                + (place.isEmpty() ? "" : " · " + place);
    }

    /** 为一批开课挂载排课时段（批量查询，避免 N+1）。 */
    public void attachSchedules(List<Map<String, Object>> offerings) {
        if (offerings == null || offerings.isEmpty()) {
            return;
        }
        List<Long> ids = new ArrayList<>();
        for (Map<String, Object> o : offerings) {
            ids.add(Db.num(o, "offering_id"));
        }
        List<Map<String, Object>> rows = db.query(
                "SELECT * FROM t_course_schedule WHERE offering_id IN (?) ORDER BY weekday, start_period",
                ids);

        Map<Long, List<Map<String, Object>>> map = new LinkedHashMap<>();
        for (Map<String, Object> r : rows) {
            map.computeIfAbsent(Db.num(r, "offering_id"), k -> new ArrayList<>()).add(r);
        }
        for (Map<String, Object> o : offerings) {
            List<Map<String, Object>> list = map.getOrDefault(Db.num(o, "offering_id"), List.of());
            List<String> texts = new ArrayList<>();
            for (Map<String, Object> s : list) {
                texts.add(scheduleText(s));
            }
            o.put("schedules", list);
            o.put("scheduleText", texts);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 开课查询                                                            */
    /* ------------------------------------------------------------------ */

    /** 查询条件 */
    public record QueryParams(long termId, String keyword, Long categoryId, Integer weekday,
                              boolean available, String campus, Integer status,
                              int page, int size, String sort) {
    }

    public record QueryResult(List<Map<String, Object>> rows, long total) {
    }

    public QueryResult queryOfferings(QueryParams p) {
        StringBuilder where = new StringBuilder("o.term_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(p.termId());

        if (p.keyword() != null && !p.keyword().isBlank()) {
            where.append(" AND (c.name LIKE ? OR c.course_code LIKE ?)");
            params.add("%" + p.keyword() + "%");
            params.add("%" + p.keyword() + "%");
        }
        if (p.categoryId() != null) {
            where.append(" AND c.category_id = ?");
            params.add(p.categoryId());
        }
        if (p.campus() != null && !p.campus().isBlank()) {
            where.append(" AND o.campus = ?");
            params.add(p.campus());
        }
        if (p.status() != null) {
            where.append(" AND o.status = ?");
            params.add(p.status());
        }
        if (p.available()) {
            where.append(" AND o.status = 1 AND o.enrolled < o.capacity");
        }
        if (p.weekday() != null) {
            where.append(" AND EXISTS (SELECT 1 FROM t_course_schedule s "
                    + "WHERE s.offering_id = o.id AND s.weekday = ?)");
            params.add(p.weekday());
        }

        // 注意：PostgreSQL 的整数除法会截断，利用率排序必须显式转 numeric，
        // 否则 o.enrolled / o.capacity 恒为 0 或 1（MySQL 的 / 返回小数，无此问题）
        String orderBy = switch (p.sort() == null ? "code" : p.sort()) {
            case "heat" -> "o.enrolled::numeric / NULLIF(o.capacity, 0) DESC NULLS LAST, c.course_code";
            case "enrolled" -> "o.enrolled DESC, c.course_code";
            default -> "c.course_code, c.name";
        };

        Long total = db.queryScalar(
                "SELECT COUNT(*) AS total FROM t_course_offering o "
                        + "JOIN t_course c ON c.id = o.course_id WHERE " + where,
                Long.class, params.toArray());

        int offset = (p.page() - 1) * p.size();
        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(p.size());
        pageParams.add(offset);

        List<Map<String, Object>> rows = db.query("""
                SELECT o.id AS offering_id, o.capacity, o.enrolled, o.status AS offering_status,
                       o.campus AS offering_campus, o.remark,
                       c.id AS course_id, c.course_code, c.name AS course_name, c.credit,
                       c.dept, c.description,
                       cat.id AS category_id, cat.name AS category_name,
                       t.id AS teacher_id, tu.real_name AS teacher_name, t.title AS teacher_title
                  FROM t_course_offering o
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_course_category cat ON cat.id = c.category_id
                  JOIN t_teacher t ON t.id = o.teacher_id
                  JOIN t_user tu ON tu.id = t.user_id
                 -- 注意：文本块会把每行「行尾空白」剥掉，所以 WHERE 后面不能直接写空格，
                 -- 必须用 \s 转义，否则与下面的 where 片段拼起来会变成 WHEREo.term_id
                 WHERE\s""" + where + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?",
                pageParams.toArray());

        return new QueryResult(rows, total == null ? 0 : total);
    }

    /* ------------------------------------------------------------------ */
    /* 学生选课上下文                                                       */
    /* ------------------------------------------------------------------ */

    /** 学生侧的选课上下文：批次、学分、类别要求、退课截止。 */
    public static final class StudentContext {
        public long studentId;
        public Map<String, Object> student;
        public long termId;
        public RuleService.BatchInfo batchInfo;
        public RuleService.CreditSummary creditSummary;
        public Map<String, Object> creditRule;
        public List<Map<String, Object>> categoryRules;
        public Timestamp dropDeadline;

        public String grade() {
            return Db.str(student, "grade");
        }
    }

    public StudentContext buildStudentContext(Map<String, Object> student, long termId) {
        StudentContext ctx = new StudentContext();
        ctx.studentId = Db.num(student, "id");
        ctx.student = student;
        ctx.termId = termId;
        ctx.batchInfo = rules.resolveBatch(termId, student);
        ctx.creditSummary = rules.getCreditSummary(ctx.studentId, termId);
        ctx.creditRule = rules.getCreditRule(termId, ctx.grade());
        ctx.categoryRules = rules.getCategoryCreditRules(termId);
        ctx.dropDeadline = rules.getDropDeadline(termId);
        return ctx;
    }

    /* ------------------------------------------------------------------ */
    /* 状态标注（表 6）                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * 批量标注选课状态。一次查询完成已选集合、候补集合、候补人数、冲突映射、先修满足情况。
     *
     * <p>状态取值：AVAILABLE 可选 / SELECTED 已选 / WAITLISTED 候补中 / FULL 已满 /
     * CLOSED 停开 / OUT_OF_BATCH 不在批次 / CONFLICT 冲突 / INELIGIBLE 学分或先修不满足。
     */
    public void annotateOfferings(List<Map<String, Object>> offerings, StudentContext ctx) {
        if (offerings == null || offerings.isEmpty()) {
            return;
        }
        List<Long> offeringIds = new ArrayList<>();
        for (Map<String, Object> o : offerings) {
            offeringIds.add(Db.num(o, "offering_id"));
        }

        // 1) 已选
        Map<Long, Map<String, Object>> selectedMap = new LinkedHashMap<>();
        for (Map<String, Object> r : db.query("""
                SELECT offering_id, status, source, select_time FROM t_enrollment
                 WHERE student_id = ? AND offering_id IN (?)
                """, ctx.studentId, offeringIds)) {
            if (Db.num(r, "status") == 1) {
                selectedMap.put(Db.num(r, "offering_id"), r);
            }
        }

        // 2) 我的候补
        Map<Long, Map<String, Object>> waitMap = new LinkedHashMap<>();
        for (Map<String, Object> r : db.query("""
                SELECT offering_id, queue_no, status FROM t_waitlist
                 WHERE student_id = ? AND offering_id IN (?) AND status = 1
                """, ctx.studentId, offeringIds)) {
            waitMap.put(Db.num(r, "offering_id"), r);
        }

        // 3) 各开课候补总人数
        Map<Long, Long> waitCountMap = new LinkedHashMap<>();
        for (Map<String, Object> r : db.query("""
                SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist
                 WHERE offering_id IN (?) AND status = 1 GROUP BY offering_id
                """, offeringIds)) {
            waitCountMap.put(Db.num(r, "offering_id"), Db.num(r, "cnt"));
        }

        // 4) 冲突映射：一次性比对本页全部开课与本人已选开课的排课
        Map<Long, List<Map<String, Object>>> conflictMap = new LinkedHashMap<>();
        for (Map<String, Object> r : db.query("""
                SELECT DISTINCT s1.offering_id AS offering_id,
                       c2.name AS other_course_name, c2.course_code AS other_course_code,
                       s1.weekday AS weekday, s1.start_period AS start_period,
                       s1.end_period AS end_period, s1.parity AS parity,
                       s2.start_period AS other_start_period, s2.end_period AS other_end_period,
                       s2.parity AS other_parity, s1.campus AS campus, s2.campus AS other_campus
                  FROM t_course_schedule s1
                  JOIN t_course_schedule s2
                    ON s2.weekday = s1.weekday
                   AND s1.start_period <= s2.end_period
                   AND s2.start_period <= s1.end_period
                   AND NOT ((s1.parity = 1 AND s2.parity = 2) OR (s1.parity = 2 AND s2.parity = 1))
                  JOIN t_enrollment e ON e.offering_id = s2.offering_id
                                     AND e.student_id = ? AND e.status = 1
                  JOIN t_course_offering o2 ON o2.id = s2.offering_id AND o2.term_id = ?
                  JOIN t_course c2 ON c2.id = o2.course_id
                 WHERE s1.offering_id IN (?) AND s2.offering_id <> s1.offering_id
                """, ctx.studentId, ctx.termId, offeringIds)) {
            long offeringId = Db.num(r, "offering_id");
            int weekday = (int) Db.num(r, "weekday");
            int start = (int) Db.num(r, "start_period");
            int end = (int) Db.num(r, "end_period");
            int parity = (int) Db.num(r, "parity");

            Map<String, Object> c = new LinkedHashMap<>();
            c.put("courseName", r.get("other_course_name"));
            c.put("courseCode", r.get("other_course_code"));
            c.put("weekday", weekday);
            c.put("weekdayText", weekdayText(weekday));
            c.put("parityText", parityText(parity));
            c.put("otherParityText", parityText((int) Db.num(r, "other_parity")));
            c.put("periods", start + "-" + end + " 节");
            c.put("otherPeriods", Db.num(r, "other_start_period") + "-" + Db.num(r, "other_end_period") + " 节");
            c.put("campus", r.get("campus"));
            c.put("otherCampus", r.get("other_campus"));
            conflictMap.computeIfAbsent(offeringId, k -> new ArrayList<>()).add(c);
        }

        // 5) 先修满足情况：一次性取本页课程的全部先修要求
        Set<Long> courseIds = new LinkedHashSet<>();
        for (Map<String, Object> o : offerings) {
            courseIds.add(Db.num(o, "course_id"));
        }
        Map<Long, List<Map<String, Object>>> prereqMap = new LinkedHashMap<>();
        for (Map<String, Object> r : db.query("""
                SELECT p.course_id, p.require_type, p.group_no,
                       c.name AS prereq_name, c.course_code,
                       COALESCE(h.is_passed, 0) AS passed
                  FROM t_course_prereq p
                  JOIN t_course c ON c.id = p.prereq_course_id
                  LEFT JOIN t_student_course_history h
                         ON h.course_id = p.prereq_course_id AND h.student_id = ?
                 WHERE p.course_id IN (?)
                """, ctx.studentId, courseIds)) {
            prereqMap.computeIfAbsent(Db.num(r, "course_id"), k -> new ArrayList<>()).add(r);
        }

        boolean batchOk = ctx.batchInfo.batch() != null;
        BigDecimal maxCredit = ctx.creditRule == null ? null : Db.decimal(ctx.creditRule, "max_credit");

        for (Map<String, Object> o : offerings) {
            long offeringId = Db.num(o, "offering_id");
            Map<String, Object> selected = selectedMap.get(offeringId);
            Map<String, Object> wait = waitMap.get(offeringId);
            List<Map<String, Object>> conflicts = conflictMap.getOrDefault(offeringId, List.of());
            List<String> missingPrereq = missingPrereq(prereqMap.get(Db.num(o, "course_id")));

            BigDecimal credit = Db.decimal(o, "credit");
            BigDecimal willTotal = ctx.creditSummary.total().add(credit);
            boolean creditExceed = maxCredit != null && willTotal.compareTo(maxCredit) > 0;

            long enrolled = Db.num(o, "enrolled");
            long capacity = Db.num(o, "capacity");
            long offeringStatus = Db.num(o, "offering_status");
            boolean full = enrolled >= capacity || offeringStatus == 2;
            boolean closed = offeringStatus == 0;

            List<Map<String, Object>> reasons = new ArrayList<>();
            if (!conflicts.isEmpty()) {
                Map<String, Object> c0 = conflicts.get(0);
                reasons.add(reason(2002, "与《" + c0.get("courseName") + "》冲突（"
                        + c0.get("weekdayText") + " " + c0.get("periods") + "）"));
            }
            if (creditExceed) {
                reasons.add(reason(2003, "选后将达 " + RuleService.plain(willTotal)
                        + " 学分，超出上限 " + RuleService.plain(maxCredit)));
            }
            if (!missingPrereq.isEmpty()) {
                reasons.add(reason(2004, "需先修：" + String.join("、", missingPrereq)));
            }
            if (!batchOk) {
                reasons.add(reason(2005, "当前不在你的选课批次时间内"));
            }
            if (full) {
                reasons.add(reason(2001, "名额已满，可加入候补"));
            }

            String status = "AVAILABLE";
            if (closed) {
                status = "CLOSED";
            } else if (selected != null) {
                status = "SELECTED";
            } else if (wait != null) {
                status = "WAITLISTED";
            } else if (!batchOk) {
                status = "OUT_OF_BATCH";
            } else if (full) {
                status = "FULL";
            } else if (!conflicts.isEmpty()) {
                status = "CONFLICT";
            } else if (creditExceed || !missingPrereq.isEmpty()) {
                status = "INELIGIBLE";
            }

            o.put("status", status);
            o.put("selectable", "AVAILABLE".equals(status));
            o.put("waitlistable", ("FULL".equals(status) || "CLOSED".equals(status))
                    && selected == null && wait == null);
            o.put("willTotalCredit", willTotal);
            o.put("heat", RuleService.heatOf(enrolled, capacity));
            o.put("reasons", reasons);
            o.put("conflicts", conflicts);
            o.put("missingPrereq", missingPrereq);

            if (selected != null) {
                Map<String, Object> me = new LinkedHashMap<>();
                me.put("status", Db.num(selected, "status"));
                me.put("source", Db.num(selected, "source"));
                me.put("selectTime", selected.get("select_time"));
                o.put("myEnrollment", me);
            } else {
                o.put("myEnrollment", null);
            }
            o.put("myWaitlist", wait == null ? null
                    : Map.of("queueNo", Db.num(wait, "queue_no"), "status", Db.num(wait, "status")));
            o.put("waitlistCount", waitCountMap.getOrDefault(offeringId, 0L));
            o.put("remaining", Math.max(0, capacity - enrolled));
        }
    }

    private static List<String> missingPrereq(List<Map<String, Object>> rows) {
        if (rows == null || rows.isEmpty()) {
            return List.of();
        }
        List<String> miss = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            if (Db.num(r, "require_type") == 1 && !Db.flag(r, "passed")) {
                miss.add(String.valueOf(r.get("prereq_name")));
            }
        }
        Map<Long, List<Map<String, Object>>> groups = new LinkedHashMap<>();
        for (Map<String, Object> r : rows) {
            if (Db.num(r, "require_type") == 2) {
                groups.computeIfAbsent(Db.num(r, "group_no"), k -> new ArrayList<>()).add(r);
            }
        }
        for (List<Map<String, Object>> g : groups.values()) {
            if (g.stream().noneMatch(x -> Db.flag(x, "passed"))) {
                for (Map<String, Object> x : g) {
                    miss.add(String.valueOf(x.get("prereq_name")));
                }
            }
        }
        return new ArrayList<>(new LinkedHashSet<>(miss));
    }

    private static Map<String, Object> reason(int code, String text) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("text", text);
        return m;
    }

    /* ------------------------------------------------------------------ */
    /* 开课详情                                                            */
    /* ------------------------------------------------------------------ */

    /** 开课详情：含排课、余量、热度、先修要求、候补队列与本人可选状态。 */
    public Map<String, Object> getOfferingDetail(long offeringId, StudentContext ctx) {
        List<Map<String, Object>> rows = db.query("""
                SELECT o.id AS offering_id, o.capacity, o.enrolled, o.status AS offering_status,
                       o.campus AS offering_campus, o.remark,
                       c.id AS course_id, c.course_code, c.name AS course_name, c.credit,
                       c.dept, c.description,
                       cat.id AS category_id, cat.name AS category_name,
                       t.id AS teacher_id, tu.real_name AS teacher_name,
                       t.title AS teacher_title, t.college AS teacher_college
                  FROM t_course_offering o
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_course_category cat ON cat.id = c.category_id
                  JOIN t_teacher t ON t.id = o.teacher_id
                  JOIN t_user tu ON tu.id = t.user_id
                 WHERE o.id = ? AND o.term_id = ?
                """, offeringId, ctx.termId);
        if (rows.isEmpty()) {
            return null;
        }
        attachSchedules(rows);
        annotateOfferings(rows, ctx);
        Map<String, Object> o = rows.get(0);

        List<Map<String, Object>> prereqList = new ArrayList<>();
        for (Map<String, Object> r : db.query("""
                SELECT p.require_type, p.group_no, c.name AS prereq_name, c.course_code,
                       COALESCE(h.is_passed, 0) AS passed
                  FROM t_course_prereq p
                  JOIN t_course c ON c.id = p.prereq_course_id
                  LEFT JOIN t_student_course_history h
                         ON h.course_id = p.prereq_course_id AND h.student_id = ?
                 WHERE p.course_id = ?
                """, ctx.studentId, Db.num(o, "course_id"))) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", r.get("prereq_name"));
            m.put("code", r.get("course_code"));
            m.put("requireType", Db.num(r, "require_type"));
            m.put("groupNo", Db.num(r, "group_no"));
            m.put("passed", Db.flag(r, "passed"));
            prereqList.add(m);
        }
        o.put("prereqList", prereqList);

        List<Map<String, Object>> queue = new ArrayList<>();
        for (Map<String, Object> q : db.query("""
                SELECT w.queue_no, s.student_no, u.real_name
                  FROM t_waitlist w
                  JOIN t_student s ON s.id = w.student_id
                  JOIN t_user u ON u.id = s.user_id
                 WHERE w.offering_id = ? AND w.status = 1
                 ORDER BY w.queue_no LIMIT 10
                """, offeringId)) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("queueNo", Db.num(q, "queue_no"));
            m.put("studentNo", q.get("student_no"));
            m.put("name", q.get("real_name"));
            queue.add(m);
        }
        o.put("waitlistQueue", queue);
        return o;
    }

    /** 拼接非空字段 */
    static String joinNonBlank(String sep, String... parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (p != null && !p.isBlank()) {
                if (sb.length() > 0) {
                    sb.append(sep);
                }
                sb.append(p);
            }
        }
        return sb.toString();
    }
}
