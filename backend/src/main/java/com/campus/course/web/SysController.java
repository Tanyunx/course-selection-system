package com.campus.course.web;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.campus.course.common.Api;
import com.campus.course.common.ApiResponse;
import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.config.AppProperties;
import com.campus.course.db.Db;
import com.campus.course.security.CurrentUser;
import com.campus.course.security.RequireRole;
import com.campus.course.security.Role;
import com.campus.course.security.SessionStore;
import com.campus.course.service.AuditService;
import com.campus.course.store.MetricsStore;

/**
 * 系统管理端接口
 * （对应设计文档 3.5、表 4 与表 26，等价于原 Node 版的 routes/sys.js）。
 *
 * <p>权限：系统管理员（sys_admin），涵盖用户与权限管理、审计日志、运行监控。
 * 与原实现一致：这三组接口与教务端互不重叠，教务管理员访问本组接口会被拒（1003）。
 */
@RestController
@RequestMapping("/api/admin")
@RequireRole(Role.SYS_ADMIN)
public class SysController {

    private final Db db;
    private final SessionStore sessions;
    private final MetricsStore metrics;
    private final AuditService audit;
    private final AppProperties props;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public SysController(Db db, SessionStore sessions, MetricsStore metrics,
                         AuditService audit, AppProperties props) {
        this.db = db;
        this.sessions = sessions;
        this.metrics = metrics;
        this.audit = audit;
        this.props = props;
    }

    /* ------------------------------------------------------------------ */
    /* 用户与权限                                                          */
    /* ------------------------------------------------------------------ */

    @GetMapping("/users")
    public ApiResponse users(@RequestParam Map<String, String> q) {
        int pageNo = Math.max(1, Api.intOf(q.get("page"), 1));
        int size = Math.min(Api.intOf(q.get("size"), 20), 100);

        StringBuilder where = new StringBuilder("1 = 1");
        List<Object> params = new ArrayList<>();
        if (q.get("keyword") != null && !q.get("keyword").isBlank()) {
            where.append(" AND (u.username LIKE ? OR u.real_name LIKE ?)");
            params.add("%" + q.get("keyword") + "%");
            params.add("%" + q.get("keyword") + "%");
        }
        if (q.get("role") != null && !q.get("role").isBlank()) {
            where.append(" AND u.role = ?");
            params.add(Api.intOf(q.get("role"), 0));
        }
        if (q.get("status") != null && !q.get("status").isBlank()) {
            where.append(" AND u.status = ?");
            params.add(Api.intOf(q.get("status"), 1));
        }

        Long total = db.queryScalar(
                "SELECT COUNT(*) AS total FROM t_user u WHERE " + where, Long.class, params.toArray());

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(size);
        pageParams.add((pageNo - 1) * size);
        List<Map<String, Object>> rows = db.query("""
                SELECT u.id, u.username, u.real_name, u.role, u.status, u.last_login_at, u.created_at,
                       s.student_no, s.grade, s.college, s.major,
                       t.teacher_no, t.college AS teacher_college, t.title
                  FROM t_user u
                  LEFT JOIN t_student s ON s.user_id = u.id
                  LEFT JOIN t_teacher t ON t.user_id = u.id
                 WHERE\s""" + where + " ORDER BY u.role, u.username LIMIT ? OFFSET ?",
                pageParams.toArray());

        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            Map<String, Object> m = new LinkedHashMap<>(r);
            m.put("roleText", Role.label((int) Db.num(r, "role")));
            list.add(m);
        }
        return Api.page(list, total == null ? 0 : total, pageNo, size);
    }

    @PostMapping("/users")
    public ApiResponse createUser(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String username = Api.strOf(b.get("username"));
        String password = b.get("password") == null ? null : String.valueOf(b.get("password"));
        String realName = Api.strOf(b.get("realName"));
        Long role = Api.longOf(b.get("role"));
        if (username == null || password == null || password.isEmpty() || realName == null || role == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "账号、密码、姓名与角色为必填项");
        }
        if (db.queryOne("SELECT id FROM t_user WHERE username = ?", username) != null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "账号 " + username + " 已存在");
        }

        long userId = db.withTransaction(() -> {
            long newId = db.insertReturningId("""
                    INSERT INTO t_user (username, password_hash, real_name, role, status)
                    VALUES (?, ?, ?, ?, 1)
                    """, username, encoder.encode(password), realName, role);
            if (role == Role.STUDENT) {
                db.update("""
                        INSERT INTO t_student (user_id, student_no, grade, college, major)
                        VALUES (?, ?, ?, ?, ?)
                        """, newId,
                        Api.strOf(b.get("studentNo")) != null ? Api.strOf(b.get("studentNo")) : username,
                        Api.strOf(b.get("grade")) != null ? Api.strOf(b.get("grade")) : "",
                        Api.strOf(b.get("college")) != null ? Api.strOf(b.get("college")) : "",
                        Api.strOf(b.get("major")));
            } else if (role == Role.TEACHER) {
                db.update("""
                        INSERT INTO t_teacher (user_id, teacher_no, college, title) VALUES (?, ?, ?, ?)
                        """, newId,
                        Api.strOf(b.get("teacherNo")) != null ? Api.strOf(b.get("teacherNo")) : username,
                        Api.strOf(b.get("college")) != null ? Api.strOf(b.get("college")) : "",
                        Api.strOf(b.get("title")));
            }
            return newId;
        });

        audit.log("USER_CREATE", "USER", userId, 1, username + " / " + Role.label(role.intValue()));
        return Api.ok(Map.of("userId", userId), "用户已创建");
    }

    @PutMapping("/users/{id}")
    public ApiResponse updateUser(@PathVariable long id,
                                  @RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Map<String, Object> user = db.queryOne("SELECT * FROM t_user WHERE id = ?", id);
        if (user == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "用户不存在");
        }
        if (id == CurrentUser.userId() && b.get("status") != null && Api.intOf(b.get("status"), 1) == 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "不能禁用当前登录的管理员账号");
        }

        long newRole = (int) Db.num(user, "role");
        if (b.get("role") != null) {
            newRole = Api.intOf(b.get("role"), (int) newRole);
        }
        long newStatus = (int) Db.num(user, "status");
        if (b.get("status") != null) {
            newStatus = Api.intOf(b.get("status"), (int) newStatus);
        }
        String newName = Api.strOf(b.get("realName")) != null
                ? Api.strOf(b.get("realName")) : Db.str(user, "real_name");
        String newPassword = b.get("newPassword") == null ? null : String.valueOf(b.get("newPassword"));

        db.update("""
                UPDATE t_user SET role = ?, status = ?, real_name = ?, password_hash = ? WHERE id = ?
                """, newRole, newStatus, newName,
                newPassword != null && !newPassword.isEmpty()
                        ? encoder.encode(newPassword) : Db.str(user, "password_hash"),
                id);

        audit.log("USER_UPDATE", "USER", id, 1,
                "角色 " + Db.num(user, "role") + " → " + newRole
                        + "；状态 " + Db.num(user, "status") + " → " + newStatus
                        + (newPassword != null && !newPassword.isEmpty() ? "；已重置密码" : ""));
        return Api.ok(Map.of("id", id), "用户已更新");
    }

    /* ------------------------------------------------------------------ */
    /* 审计日志                                                            */
    /* ------------------------------------------------------------------ */

    @GetMapping("/audit-logs")
    public ApiResponse auditLogs(@RequestParam Map<String, String> q) {
        int pageNo = Math.max(1, Api.intOf(q.get("page"), 1));
        int size = Math.min(Api.intOf(q.get("size"), 20), 200);

        StringBuilder where = new StringBuilder("1 = 1");
        List<Object> params = new ArrayList<>();
        if (q.get("action") != null && !q.get("action").isBlank()) {
            where.append(" AND a.action = ?");
            params.add(q.get("action"));
        }
        if (q.get("username") != null && !q.get("username").isBlank()) {
            where.append(" AND a.username LIKE ?");
            params.add("%" + q.get("username") + "%");
        }
        if (q.get("result") != null && !q.get("result").isBlank()) {
            where.append(" AND a.result = ?");
            params.add(Api.intOf(q.get("result"), 1));
        }
        if (q.get("start") != null && !q.get("start").isBlank()) {
            where.append(" AND a.created_at >= ?");
            params.add(com.campus.course.service.RuleService.tsOf(q.get("start")));
        }
        if (q.get("end") != null && !q.get("end").isBlank()) {
            where.append(" AND a.created_at <= ?");
            params.add(com.campus.course.service.RuleService.tsOf(q.get("end")));
        }

        Long total = db.queryScalar(
                "SELECT COUNT(*) AS total FROM t_audit_log a WHERE " + where,
                Long.class, params.toArray());

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(size);
        pageParams.add((pageNo - 1) * size);
        List<Map<String, Object>> rows = db.query(
                "SELECT a.* FROM t_audit_log a WHERE " + where + " ORDER BY a.id DESC LIMIT ? OFFSET ?",
                pageParams.toArray());

        List<Object> actions = new ArrayList<>();
        for (Map<String, Object> a : db.query("SELECT DISTINCT action FROM t_audit_log ORDER BY action")) {
            actions.add(a.get("action"));
        }

        Map<String, Object> data = com.campus.course.common.ApiResponse.pageMap(
                rows, total == null ? 0 : total, pageNo, size);
        data.put("actions", actions);
        return Api.ok(data);
    }

    /* ------------------------------------------------------------------ */
    /* 运行监控                                                            */
    /* ------------------------------------------------------------------ */

    @GetMapping("/monitor")
    public ApiResponse monitor() {
        // 未引入网关排队与 Redis，队列长度与缓存差值恒为 0（设计文档 8.3 的可选增强项）
        Map<String, Object> snap = metrics.snapshot(0);
        Map<String, Object> waiting = db.queryOne(
                "SELECT COUNT(*) AS cnt FROM t_waitlist WHERE status = 1");
        Map<String, Object> activeEnroll = db.queryOne(
                "SELECT COUNT(*) AS cnt FROM t_enrollment WHERE status = 1");

        double successRate = ((Number) snap.get("successRate")).doubleValue();
        int writeP95 = ((Number) snap.get("writeP95Ms")).intValue();

        List<Map<String, Object>> thresholds = new ArrayList<>();
        thresholds.add(threshold("接口错误率", Math.round((100 - successRate) * 100) / 100.0, "%", "1%",
                100 - successRate > 1));
        thresholds.add(threshold("选课写接口 P95", writeP95, "ms", "2000ms", writeP95 > 2000));
        thresholds.add(threshold("排队队列长度", 0, "人", "200 人", false));
        thresholds.add(threshold("缓存与库余量差值", 0, "", "持续 > 0", false));

        Map<String, Object> data = new LinkedHashMap<>(snap);
        data.put("onlineUsers", sessions.onlineCount());
        data.put("waitlistTotal", waiting == null ? 0L : Db.num(waiting, "cnt"));
        data.put("activeEnrollment", activeEnroll == null ? 0L : Db.num(activeEnroll, "cnt"));
        data.put("rateLimitConfig", Map.of(
                "windowSeconds", props.getRateLimit().getWindowSeconds(),
                "softLimit", props.getRateLimit().getSoftLimit(),
                "hardLimit", props.getRateLimit().getHardLimit()));
        data.put("thresholds", thresholds);
        return Api.ok(data);
    }

    private static Map<String, Object> threshold(String name, Object value, String unit,
                                                 String threshold, boolean warn) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("value", value);
        m.put("unit", unit);
        m.put("threshold", threshold);
        m.put("level", warn ? "warn" : "ok");
        return m;
    }
}
