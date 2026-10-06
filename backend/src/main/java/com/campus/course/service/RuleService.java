package com.campus.course.service;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.config.AppProperties;
import com.campus.course.db.Db;

/**
 * 选课规则引擎（对应设计文档第 4 章，等价于原 Node 版的 services/ruleService.js）。
 *
 * <p>所有规则都在服务端强制校验，前端提示仅作辅助。
 *
 * <p>与原实现的差异：Node 版需要把事务连接 {@code conn} 层层透传（避免"事务中再向连接池
 * 申请连接"造成连接池耗尽死锁）；Java 侧 JdbcTemplate 自动加入当前事务，因此本类
 * 所有方法都只有一份实现，既能在事务内调用，也能在事务外调用，语义不变。
 */
@Service
public class RuleService {

    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");
    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    private final Db db;
    private final int dropDeadlineDaysAfterBatch;

    public RuleService(Db db, AppProperties props) {
        this.db = db;
        this.dropDeadlineDaysAfterBatch = props.getBusiness().getDropDeadlineDaysAfterBatch();
    }

    /* ------------------------------------------------------------------ */
    /* 学期                                                                */
    /* ------------------------------------------------------------------ */

    /** 取当前学期；无 is_current 标记时取最新学期。 */
    public Map<String, Object> getCurrentTerm() {
        List<Map<String, Object>> rows = db.query(
                "SELECT * FROM t_term ORDER BY is_current DESC, start_date DESC LIMIT 1");
        return rows.isEmpty() ? null : rows.get(0);
    }

    public Map<String, Object> getTermById(long termId) {
        return db.queryOne("SELECT * FROM t_term WHERE id = ?", termId);
    }

    /* ------------------------------------------------------------------ */
    /* 批次准入（4.1 / 4.5 第一层）                                          */
    /* ------------------------------------------------------------------ */

    /** 批次解析结果：命中批次、全部匹配批次、下一个即将开放的批次 */
    public record BatchInfo(Map<String, Object> batch, List<Map<String, Object>> matches,
                            Map<String, Object> next) {
        public boolean inWindow() {
            return batch != null;
        }
    }

    /**
     * 一名学生可能命中多个批次，取「优先级最高（priority 最小）且时间窗口命中」的那个。
     * 年级与学院过滤：target_grade / target_college 为空表示不限。
     */
    public BatchInfo resolveBatch(long termId, Map<String, Object> student) {
        return resolveBatch(termId, student, new java.util.Date());
    }

    public BatchInfo resolveBatch(long termId, Map<String, Object> student, java.util.Date at) {
        List<Map<String, Object>> rows = db.query("""
                SELECT * FROM t_enroll_batch
                 WHERE term_id = ? AND status = 1
                 ORDER BY priority ASC, start_time ASC
                """, termId);

        String grade = Db.str(student, "grade");
        String college = Db.str(student, "college");

        List<Map<String, Object>> matched = new ArrayList<>();
        for (Map<String, Object> b : rows) {
            String targetGrade = Db.str(b, "target_grade");
            boolean gradeOk = targetGrade == null || targetGrade.isBlank()
                    || List.of(targetGrade.split(",")).stream().map(String::trim)
                            .filter(s -> !s.isEmpty()).anyMatch(s -> s.equals(grade));
            String targetCollege = Db.str(b, "target_college");
            boolean collegeOk = targetCollege == null || targetCollege.isBlank()
                    || (college != null && targetCollege.contains(college));
            if (gradeOk && collegeOk) {
                matched.add(b);
            }
        }

        Map<String, Object> hit = null;
        Map<String, Object> next = null;
        for (Map<String, Object> b : matched) {
            Timestamp start = tsOf(b.get("start_time"));
            Timestamp end = tsOf(b.get("end_time"));
            if (hit == null && start != null && end != null
                    && !at.before(start) && !at.after(end)) {
                hit = b;
            }
            if (next == null && start != null && start.after(at)) {
                next = b;
            }
        }
        return new BatchInfo(hit, matched, next);
    }

    /** 批次校验：不在窗口内抛 2005，并给出下一批次开放时间作为提示。 */
    public Map<String, Object> assertInBatch(long termId, Map<String, Object> student) {
        return assertInBatch(termId, student, new java.util.Date());
    }

    public Map<String, Object> assertInBatch(long termId, Map<String, Object> student, java.util.Date at) {
        BatchInfo info = resolveBatch(termId, student, at);
        if (info.batch() == null) {
            String hint = info.next() == null
                    ? "当前不在任何可选批次时间内，请查看选课通知"
                    : "你的选课批次将于 " + fmt(info.next().get("start_time")) + " 开放";
            Map<String, Object> nextBatch = info.next() == null ? null : Map.of(
                    "name", String.valueOf(info.next().get("name")),
                    "startTime", fmt(info.next().get("start_time")));
            throw new BizException(ErrorCode.BATCH_OUT_OF_RANGE,
                    "当前不在你可选的选课批次时间内。" + hint,
                    Map.of("nextBatch", nextBatch == null ? Map.of() : nextBatch));
        }
        return info.batch();
    }

    /* ------------------------------------------------------------------ */
    /* 时间冲突检测（4.3）                                                   */
    /* ------------------------------------------------------------------ */

    public record ConflictResult(List<Map<String, Object>> conflicts,
                                 List<Map<String, Object>> tightTransfers) {
    }

    /**
     * 时间冲突检测。判定条件：weekday 相同、节次区间相交、单双周不互斥；
     * 一门课有多个时段时，任一时段冲突即整体冲突。
     *
     * <p>同时返回"赶课提示"：同一天相邻节次但校区不同（不阻止选课，仅提醒）。
     */
    public ConflictResult detectConflict(long offeringId, long studentId, long termId,
                                         Long... excludeOfferingIds) {
        List<Object> exclude = new ArrayList<>();
        exclude.add(offeringId);
        if (excludeOfferingIds != null) {
            for (Long x : excludeOfferingIds) {
                if (x != null) {
                    exclude.add(x);
                }
            }
        }
        String placeholders = placeholders(exclude.size());

        List<Map<String, Object>> conflicts = db.query("""
                SELECT DISTINCT
                       c.name            AS course_name,
                       c.course_code     AS course_code,
                       s2.offering_id    AS offering_id,
                       s1.weekday        AS weekday,
                       s1.start_period   AS start_period,
                       s1.end_period     AS end_period,
                       s1.parity         AS parity,
                       s2.start_period   AS other_start_period,
                       s2.end_period     AS other_end_period,
                       s2.parity         AS other_parity,
                       s1.campus         AS campus,
                       s2.campus         AS other_campus
                  FROM t_course_schedule s1
                  JOIN t_course_schedule s2
                    ON s2.weekday = s1.weekday
                   AND s1.start_period <= s2.end_period
                   AND s2.start_period <= s1.end_period
                   AND NOT ((s1.parity = 1 AND s2.parity = 2) OR (s1.parity = 2 AND s2.parity = 1))
                  JOIN t_enrollment e
                    ON e.offering_id = s2.offering_id AND e.student_id = ? AND e.status = 1
                  JOIN t_course_offering o2 ON o2.id = s2.offering_id AND o2.term_id = ?
                  JOIN t_course c ON c.id = o2.course_id
                 WHERE s1.offering_id = ? AND s2.offering_id NOT IN (""" + placeholders + ")",
                studentId, termId, offeringId, exclude.toArray());

        List<Map<String, Object>> tightTransfers = db.query("""
                SELECT DISTINCT
                       c.name AS course_name,
                       s1.weekday AS weekday,
                       s1.start_period AS start_period,
                       s1.end_period AS end_period,
                       s1.campus AS campus,
                       s2.campus AS other_campus,
                       s2.start_period AS other_start_period,
                       s2.end_period AS other_end_period
                  FROM t_course_schedule s1
                  JOIN t_course_schedule s2
                    ON s2.weekday = s1.weekday
                   AND (s2.start_period = s1.end_period + 1 OR s1.start_period = s2.end_period + 1)
                   AND COALESCE(s1.campus,'') <> COALESCE(s2.campus,'')
                   AND NOT ((s1.parity = 1 AND s2.parity = 2) OR (s1.parity = 2 AND s2.parity = 1))
                  JOIN t_enrollment e
                    ON e.offering_id = s2.offering_id AND e.student_id = ? AND e.status = 1
                  JOIN t_course_offering o2 ON o2.id = s2.offering_id AND o2.term_id = ?
                  JOIN t_course c ON c.id = o2.course_id
                 WHERE s1.offering_id = ? AND s2.offering_id NOT IN (""" + placeholders + ")",
                studentId, termId, offeringId, exclude.toArray());

        return new ConflictResult(conflicts, tightTransfers);
    }

    /* ------------------------------------------------------------------ */
    /* 学分（4.4）                                                          */
    /* ------------------------------------------------------------------ */

    public record CreditSummary(BigDecimal total, List<Map<String, Object>> byCategory) {
    }

    /** 本学期已选总学分与各类别学分。 */
    public CreditSummary getCreditSummary(long studentId, long termId) {
        List<Map<String, Object>> rows = db.query("""
                SELECT cat.id AS category_id, cat.name AS category_name,
                       SUM(c.credit) AS credit, COUNT(*) AS cnt
                  FROM t_enrollment e
                  JOIN t_course_offering o ON o.id = e.offering_id AND o.term_id = ?
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_course_category cat ON cat.id = c.category_id
                 WHERE e.student_id = ? AND e.status = 1
                 GROUP BY cat.id, cat.name
                """, termId, studentId);

        BigDecimal total = BigDecimal.ZERO;
        List<Map<String, Object>> byCategory = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            BigDecimal credit = Db.decimal(r, "credit");
            total = total.add(credit);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("categoryId", Db.num(r, "category_id"));
            m.put("categoryName", r.get("category_name"));
            m.put("credit", credit);
            m.put("count", Db.num(r, "cnt"));
            byCategory.add(m);
        }
        return new CreditSummary(total, byCategory);
    }

    /** 本学期该年级的学分上下限，未配置返回 null。 */
    public Map<String, Object> getCreditRule(long termId, String grade) {
        return db.queryOne("SELECT * FROM t_credit_rule WHERE term_id = ? AND grade = ?", termId, grade);
    }

    public List<Map<String, Object>> getCategoryCreditRules(long termId) {
        return db.query("""
                SELECT r.*, c.name AS category_name
                  FROM t_category_credit_rule r
                  JOIN t_course_category c ON c.id = r.category_id
                 WHERE r.term_id = ?
                """, termId);
    }

    /** 学分校验结果 */
    public record CreditCheck(BigDecimal maxCredit, BigDecimal willTotal, BigDecimal currentCredit) {
    }

    /** 学分校验：超过上限抛 2003（下限不用于拦截，仅作预警）。 */
    public CreditCheck assertCreditNotExceed(long studentId, long termId, String grade,
                                             BigDecimal addCredit, BigDecimal subtractCredit) {
        Map<String, Object> rule = getCreditRule(termId, grade);
        if (rule == null) {
            return new CreditCheck(null, null, null);
        }
        CreditSummary summary = getCreditSummary(studentId, termId);
        BigDecimal max = Db.decimal(rule, "max_credit");
        BigDecimal willTotal = summary.total()
                .subtract(subtractCredit == null ? BigDecimal.ZERO : subtractCredit)
                .add(addCredit == null ? BigDecimal.ZERO : addCredit);
        if (willTotal.compareTo(max) > 0) {
            throw new BizException(ErrorCode.CREDIT_EXCEED,
                    "选课后本学期总学分为 " + plain(willTotal) + "，将超出上限 " + plain(max) + " 学分",
                    payload("currentCredit", summary.total(), "addCredit", addCredit, "maxCredit", max));
        }
        return new CreditCheck(max, willTotal, summary.total());
    }

    /* ------------------------------------------------------------------ */
    /* 先修（4.7）                                                          */
    /* ------------------------------------------------------------------ */

    /** 先修校验：支持「与」（全部满足）与「或」（满足其一）；未满足抛 2004 并指明缺失课程。 */
    public List<Map<String, Object>> assertPrereqSatisfied(long studentId, long courseId) {
        List<Map<String, Object>> rows = db.query("""
                SELECT p.require_type, p.group_no,
                       c.id AS prereq_id, c.name AS prereq_name, c.course_code,
                       COALESCE(h.is_passed, 0) AS passed
                  FROM t_course_prereq p
                  JOIN t_course c ON c.id = p.prereq_course_id
                  LEFT JOIN t_student_course_history h
                         ON h.course_id = p.prereq_course_id AND h.student_id = ?
                 WHERE p.course_id = ?
                """, studentId, courseId);

        if (rows.isEmpty()) {
            return List.of();
        }

        List<Map<String, Object>> missing = new ArrayList<>();

        // 「与」关系：每一条都必须通过
        for (Map<String, Object> r : rows) {
            if (Db.num(r, "require_type") == 1 && !Db.flag(r, "passed")) {
                missing.add(Map.of(
                        "name", String.valueOf(r.get("prereq_name")),
                        "code", String.valueOf(r.get("course_code")),
                        "groupNo", Db.num(r, "group_no")));
            }
        }

        // 「或」关系：同组内满足其一即可
        Map<Long, List<Map<String, Object>>> groups = new LinkedHashMap<>();
        for (Map<String, Object> r : rows) {
            if (Db.num(r, "require_type") == 2) {
                groups.computeIfAbsent(Db.num(r, "group_no"), k -> new ArrayList<>()).add(r);
            }
        }
        for (Map.Entry<Long, List<Map<String, Object>>> e : groups.entrySet()) {
            boolean anyPassed = e.getValue().stream().anyMatch(x -> Db.flag(x, "passed"));
            if (!anyPassed) {
                for (Map<String, Object> g : e.getValue()) {
                    missing.add(Map.of(
                            "name", String.valueOf(g.get("prereq_name")),
                            "code", String.valueOf(g.get("course_code")),
                            "groupNo", e.getKey()));
                }
            }
        }

        if (!missing.isEmpty()) {
            StringBuilder text = new StringBuilder();
            for (Map<String, Object> m : missing) {
                if (text.length() > 0) {
                    text.append('、');
                }
                text.append('《').append(m.get("name")).append('》');
            }
            throw new BizException(ErrorCode.PREREQ_MISSING,
                    "需先修并通过指定先修课程：" + text, Map.of("missing", missing));
        }
        return rows;
    }

    /* ------------------------------------------------------------------ */
    /* 退课截止（4.6）                                                       */
    /* ------------------------------------------------------------------ */

    /** 退课截止时间：补退选批次结束后的第 N 天 23:59；无补退选批次返回 null。 */
    public Timestamp getDropDeadline(long termId) {
        Map<String, Object> row = db.queryOne("""
                SELECT MAX(end_time) AS t FROM t_enroll_batch
                 WHERE term_id = ? AND type = 2 AND status = 1
                """, termId);
        Timestamp base = row == null ? null : tsOf(row.get("t"));
        if (base == null) {
            return null;
        }
        LocalDateTime dl = base.toLocalDateTime()
                .plusDays(dropDeadlineDaysAfterBatch)
                .withHour(23).withMinute(59).withSecond(0).withNano(0);
        return Timestamp.valueOf(dl);
    }

    /** 是否已过退课截止，超过抛 2008；未过则返回截止时间（可能为 null：未配置补退选批次）。 */
    public Timestamp assertDropAllowed(long termId) {
        Timestamp deadline = getDropDeadline(termId);
        if (deadline != null && System.currentTimeMillis() > deadline.getTime()) {
            throw new BizException(ErrorCode.DROP_DEADLINE_PASSED,
                    "已超过退课截止时间（" + fmt(deadline) + "），无法退课",
                    payload("deadline", deadline));
        }
        return deadline;
    }

    /* ------------------------------------------------------------------ */
    /* 工具                                                                */
    /* ------------------------------------------------------------------ */

    /** 竞争热度口径（4.2 / 3.2.2）：利用率 ≥90% 高、60%~90% 中、<60% 低。 */
    public static String heatOf(long enrolled, long capacity) {
        if (capacity <= 0) {
            return "低";
        }
        double rate = (double) enrolled / capacity;
        if (rate >= 0.9) {
            return "高";
        }
        if (rate >= 0.6) {
            return "中";
        }
        return "低";
    }

    public static String fmt(Object value) {
        Timestamp ts = tsOf(value);
        return ts == null ? "" : ts.toLocalDateTime().format(FMT);
    }

    public static Timestamp tsOf(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Timestamp t) {
            return t;
        }
        if (v instanceof java.util.Date d) {
            return new Timestamp(d.getTime());
        }
        if (v instanceof LocalDateTime ldt) {
            return Timestamp.valueOf(ldt);
        }
        return Timestamp.valueOf(String.valueOf(v).replace('T', ' '));
    }

    public static LocalDateTime localOf(Object v) {
        Timestamp ts = tsOf(v);
        return ts == null ? null : ts.toLocalDateTime();
    }

    public static java.util.Date dateOf(Object v) {
        Timestamp ts = tsOf(v);
        return ts == null ? null : new java.util.Date(ts.getTime());
    }

    public static String plain(BigDecimal v) {
        if (v == null) {
            return "0";
        }
        return v.stripTrailingZeros().scale() <= 0
                ? v.toBigInteger().toString()
                : v.stripTrailingZeros().toPlainString();
    }

    /** 生成 n 个 ? 占位符 */
    public static String placeholders(int n) {
        StringBuilder sb = new StringBuilder(n * 2);
        for (int i = 0; i < n; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append('?');
        }
        return sb.toString();
    }

    /** 构造可序列化的补充数据（BizException 的 data 字段） */
    public static Map<String, Object> payload(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }

    static ZoneId zone() {
        return ZONE;
    }
}
