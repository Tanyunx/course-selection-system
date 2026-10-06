package com.campus.course.web;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.DeleteMapping;
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
import com.campus.course.db.Db;
import com.campus.course.security.CurrentUser;
import com.campus.course.security.RequireRole;
import com.campus.course.security.Role;
import com.campus.course.service.AuditService;
import com.campus.course.service.CourseService;
import com.campus.course.service.NoticeService;
import com.campus.course.service.RuleService;
import com.campus.course.service.WaitlistService;
import com.campus.course.util.Period;

/**
 * 教务管理端接口
 * （对应设计文档 3.4、表 4 与表 26 角色权限矩阵，等价于原 Node 版的 routes/admin.js）。
 *
 * <p>权限：教务管理员（academic_admin）。系统管理员在本组接口中不含权限——
 * 用户与权限、审计日志、运行监控三组接口由 {@link SysController} 提供，
 * 两侧职责与原实现一致，不互相越界。
 */
@RestController
@RequestMapping("/api/admin")
@RequireRole(Role.ACADEMIC_ADMIN)
public class AdminController {

    private final Db db;
    private final RuleService rules;
    private final CourseService courses;
    private final NoticeService notice;
    private final AuditService audit;
    private final WaitlistService waitlist;

    public AdminController(Db db, RuleService rules, CourseService courses, NoticeService notice,
                           AuditService audit, WaitlistService waitlist) {
        this.db = db;
        this.rules = rules;
        this.courses = courses;
        this.notice = notice;
        this.audit = audit;
        this.waitlist = waitlist;
    }

    /* ------------------------------------------------------------------ */
    /* 概览                                                                */
    /* ------------------------------------------------------------------ */

    @GetMapping("/dashboard")
    public ApiResponse dashboard() {
        Map<String, Object> term = rules.getCurrentTerm();
        long termId = Db.num(term, "id");

        Map<String, Object> stat = db.queryOne("""
                SELECT COUNT(*) AS offering_count,
                       COALESCE(SUM(capacity), 0) AS total_capacity,
                       COALESCE(SUM(enrolled), 0) AS total_enrolled
                  FROM t_course_offering WHERE term_id = ? AND status <> 0
                """, termId);
        Map<String, Object> enrollCount = db.queryOne("""
                SELECT COUNT(*) AS cnt FROM t_enrollment e
                  JOIN t_course_offering o ON o.id = e.offering_id
                 WHERE o.term_id = ? AND e.status = 1
                """, termId);
        Map<String, Object> waitCount = db.queryOne("""
                SELECT COUNT(*) AS cnt FROM t_waitlist w
                  JOIN t_course_offering o ON o.id = w.offering_id
                 WHERE o.term_id = ? AND w.status = 1
                """, termId);
        Map<String, Object> studentCount = db.queryOne("SELECT COUNT(*) AS cnt FROM t_student");
        Map<String, Object> full = db.queryOne(
                "SELECT COUNT(*) AS cnt FROM t_course_offering WHERE term_id = ? AND enrolled >= capacity",
                termId);

        // 注意：PostgreSQL 整数除法会截断，利用率必须显式转 numeric
        List<Map<String, Object>> hot = db.query("""
                SELECT o.id AS offering_id, c.name AS course_name, c.course_code,
                       o.capacity, o.enrolled,
                       ROUND(o.enrolled::numeric / NULLIF(o.capacity, 0) * 100, 1) AS rate
                  FROM t_course_offering o JOIN t_course c ON c.id = o.course_id
                 WHERE o.term_id = ? AND o.status <> 0
                 ORDER BY rate DESC NULLS LAST LIMIT 8
                """, termId);
        List<Map<String, Object>> batches = db.query(
                "SELECT * FROM t_enroll_batch WHERE term_id = ? ORDER BY priority", termId);

        long totalCapacity = Db.num(stat, "total_capacity");
        long totalEnrolled = Db.num(stat, "total_enrolled");

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("term", term);
        data.put("offeringCount", Db.num(stat, "offering_count"));
        data.put("totalCapacity", totalCapacity);
        data.put("totalEnrolled", totalEnrolled);
        data.put("utilization", totalCapacity == 0 ? 0
                : Math.round((double) totalEnrolled / totalCapacity * 1000) / 10.0);
        data.put("enrollCount", Db.num(enrollCount, "cnt"));
        data.put("waitCount", Db.num(waitCount, "cnt"));
        data.put("studentCount", Db.num(studentCount, "cnt"));
        data.put("fullCount", Db.num(full, "cnt"));
        data.put("hotCourses", hot);
        data.put("batches", batches);
        return Api.ok(data);
    }

    /* ------------------------------------------------------------------ */
    /* 课程目录                                                            */
    /* ------------------------------------------------------------------ */

    @GetMapping("/courses")
    public ApiResponse courses(@RequestParam Map<String, String> q) {
        int pageNo = Math.max(1, Api.intOf(q.get("page"), 1));
        int size = Math.min(Api.intOf(q.get("size"), 20), 100);

        StringBuilder where = new StringBuilder("1 = 1");
        List<Object> params = new ArrayList<>();
        if (q.get("keyword") != null && !q.get("keyword").isBlank()) {
            where.append(" AND (c.name LIKE ? OR c.course_code LIKE ?)");
            params.add("%" + q.get("keyword") + "%");
            params.add("%" + q.get("keyword") + "%");
        }
        if (q.get("categoryId") != null && !q.get("categoryId").isBlank()) {
            where.append(" AND c.category_id = ?");
            params.add(Api.intOf(q.get("categoryId"), 0));
        }

        Long total = db.queryScalar("SELECT COUNT(*) AS total FROM t_course c WHERE " + where,
                Long.class, params.toArray());

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(size);
        pageParams.add((pageNo - 1) * size);
        List<Map<String, Object>> rows = db.query("""
                SELECT c.*, cat.name AS category_name,
                       (SELECT COUNT(*) FROM t_course_offering o WHERE o.course_id = c.id) AS offering_count,
                       (SELECT COUNT(*) FROM t_course_prereq p WHERE p.course_id = c.id) AS prereq_count
                  FROM t_course c JOIN t_course_category cat ON cat.id = c.category_id
                 WHERE\s""" + where + " ORDER BY c.course_code LIMIT ? OFFSET ?",
                pageParams.toArray());

        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            Map<String, Object> m = new LinkedHashMap<>(r);
            m.put("credit", Db.decimal(r, "credit"));
            list.add(m);
        }
        return Api.page(list, total == null ? 0 : total, pageNo, size);
    }

    @PostMapping("/courses")
    public ApiResponse createCourse(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String courseCode = Api.strOf(b.get("courseCode"));
        String name = Api.strOf(b.get("name"));
        Long categoryId = Api.longOf(b.get("categoryId"));
        Object credit = b.get("credit");
        if (courseCode == null || name == null || categoryId == null || credit == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "课程代码、名称、类别与学分为必填项");
        }
        if (db.queryOne("SELECT id FROM t_course WHERE course_code = ?", courseCode) != null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "课程代码 " + courseCode + " 已存在");
        }
        long id = db.insertReturningId("""
                INSERT INTO t_course (course_code, name, category_id, credit, dept, description, status)
                VALUES (?, ?, ?, ?, ?, ?, 1)
                """, courseCode, name, categoryId, Db.toLong(credit),
                Api.strOf(b.get("dept")), Api.strOf(b.get("description")));
        audit.log("COURSE_CREATE", "COURSE", id, 1, name);
        return Api.ok(Map.of("id", id), "课程已创建");
    }

    @PutMapping("/courses/{id}")
    public ApiResponse updateCourse(@PathVariable long id,
                                    @RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Map<String, Object> course = db.queryOne("SELECT * FROM t_course WHERE id = ?", id);
        if (course == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "课程不存在");
        }
        db.update("""
                UPDATE t_course SET name = ?, category_id = ?, credit = ?, dept = ?,
                                    description = ?, status = ? WHERE id = ?
                """,
                b.get("name") != null ? Api.strOf(b.get("name")) : Db.str(course, "name"),
                b.get("categoryId") != null ? Api.intOf(b.get("categoryId"), 0)
                        : Db.num(course, "category_id"),
                b.get("credit") != null ? Db.decimal(b, "credit") : Db.decimal(course, "credit"),
                b.containsKey("dept") ? Api.strOf(b.get("dept")) : course.get("dept"),
                b.containsKey("description") ? Api.strOf(b.get("description")) : course.get("description"),
                b.get("status") != null ? Api.intOf(b.get("status"), 1) : Db.num(course, "status"),
                id);
        audit.log("COURSE_UPDATE", "COURSE", id, 1,
                b.get("name") != null ? Api.strOf(b.get("name")) : Db.str(course, "name"));
        return Api.ok(Map.of("id", id), "课程已更新");
    }

    @DeleteMapping("/courses/{id}")
    public ApiResponse deleteCourse(@PathVariable long id) {
        Map<String, Object> used = db.queryOne(
                "SELECT COUNT(*) AS cnt FROM t_course_offering WHERE course_id = ?", id);
        if (Db.num(used, "cnt") > 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "该课程已有开课记录，不能删除，可改为停用");
        }
        db.update("DELETE FROM t_course_prereq WHERE course_id = ? OR prereq_course_id = ?", id, id);
        db.update("DELETE FROM t_course WHERE id = ?", id);
        audit.log("COURSE_DELETE", "COURSE", id, 1, null);
        return Api.ok(Map.of("id", id), "课程已删除");
    }

    /** 查询先修关系 */
    @GetMapping("/courses/{id}/prereq")
    public ApiResponse prereq(@PathVariable long id) {
        List<Map<String, Object>> rows = db.query("""
                SELECT p.*, c.name AS prereq_name, c.course_code
                  FROM t_course_prereq p JOIN t_course c ON c.id = p.prereq_course_id
                 WHERE p.course_id = ? ORDER BY p.require_type, p.group_no
                """, id);
        return Api.ok(Map.of("list", rows));
    }

    /** 整体替换先修关系 */
    @PostMapping("/courses/{id}/prereq")
    public ApiResponse savePrereq(@PathVariable long courseId,
                                  @RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        List<Map<String, Object>> list = new ArrayList<>();
        if (b.get("prereq") instanceof List<?> raw) {
            for (Object item : raw) {
                if (item instanceof Map<?, ?> m) {
                    Map<String, Object> mm = new LinkedHashMap<>();
                    m.forEach((k, v) -> mm.put(String.valueOf(k), v));
                    list.add(mm);
                }
            }
        }
        db.inTransaction(() -> {
            db.update("DELETE FROM t_course_prereq WHERE course_id = ?", courseId);
            for (Map<String, Object> p : list) {
                db.update("""
                        INSERT INTO t_course_prereq (course_id, prereq_course_id, require_type, group_no)
                        VALUES (?, ?, ?, ?)
                        """, courseId, Api.longOf(p.get("prereqCourseId")),
                        Api.intOf(p.get("requireType"), 1), Api.intOf(p.get("groupNo"), 1));
            }
        });
        audit.log("PREREQ_UPDATE", "COURSE", courseId, 1, "先修关系 " + list.size() + " 条");
        return Api.ok(Map.of("courseId", courseId, "count", list.size()), "先修关系已保存");
    }

    /* ------------------------------------------------------------------ */
    /* 开课计划与名额                                                       */
    /* ------------------------------------------------------------------ */

    @GetMapping("/offerings")
    public ApiResponse offerings(@RequestParam(required = false) Long termId) {
        Map<String, Object> term = rules.getCurrentTerm();
        long tid = termId != null ? termId : Db.num(term, "id");

        List<Map<String, Object>> rows = db.query("""
                SELECT o.id AS offering_id, o.capacity, o.enrolled, o.status, o.campus, o.remark,
                       c.course_code, c.name AS course_name, c.credit, c.id AS course_id,
                       cat.name AS category_name, t.id AS teacher_id, tu.real_name AS teacher_name
                  FROM t_course_offering o
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_course_category cat ON cat.id = c.category_id
                  JOIN t_teacher t ON t.id = o.teacher_id
                  JOIN t_user tu ON tu.id = t.user_id
                 WHERE o.term_id = ? ORDER BY c.course_code
                """, tid);
        courses.attachSchedules(rows);

        Map<Long, Long> waitMap = new LinkedHashMap<>();
        Map<Long, Long> enrollMap = new LinkedHashMap<>();
        if (!rows.isEmpty()) {
            List<Long> ids = new ArrayList<>();
            for (Map<String, Object> r : rows) {
                ids.add(Db.num(r, "offering_id"));
            }
            for (Map<String, Object> c : db.query("""
                    SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist
                     WHERE status = 1 AND offering_id IN (?) GROUP BY offering_id
                    """, ids)) {
                waitMap.put(Db.num(c, "offering_id"), Db.num(c, "cnt"));
            }
            for (Map<String, Object> c : db.query("""
                    SELECT offering_id, COUNT(*) AS cnt FROM t_enrollment
                     WHERE status = 1 AND offering_id IN (?) GROUP BY offering_id
                    """, ids)) {
                enrollMap.put(Db.num(c, "offering_id"), Db.num(c, "cnt"));
            }
        }

        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            Map<String, Object> m = new LinkedHashMap<>(r);
            m.put("credit", Db.decimal(r, "credit"));
            m.put("remaining", Math.max(0, Db.num(r, "capacity") - Db.num(r, "enrolled")));
            m.put("heat", RuleService.heatOf(Db.num(r, "enrolled"), Db.num(r, "capacity")));
            m.put("waitlistCount", waitMap.getOrDefault(Db.num(r, "offering_id"), 0L));
            m.put("enrolledCount", enrollMap.getOrDefault(Db.num(r, "offering_id"), 0L));
            list.add(m);
        }

        List<Map<String, Object>> teachers = db.query("""
                SELECT t.id, t.teacher_no, u.real_name, t.college, t.title
                  FROM t_teacher t JOIN t_user u ON u.id = t.user_id ORDER BY t.teacher_no
                """);
        List<Map<String, Object>> courseList = db.query("""
                SELECT c.id, c.course_code, c.name, c.credit, c.category_id
                  FROM t_course c WHERE c.status = 1 ORDER BY c.course_code
                """);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("term", term);
        data.put("list", list);
        data.put("teachers", teachers);
        data.put("courses", courseList);
        return Api.ok(data);
    }

    @PostMapping("/offerings")
    public ApiResponse createOffering(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Long courseId = Api.longOf(b.get("courseId"));
        Long teacherId = Api.longOf(b.get("teacherId"));
        Object capacity = b.get("capacity");
        if (courseId == null || teacherId == null || capacity == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "课程、教师与容量为必填项");
        }
        Map<String, Object> term = rules.getCurrentTerm();
        long tid = Api.longOf(b.get("termId")) != null ? Api.longOf(b.get("termId")) : Db.num(term, "id");

        if (db.queryOne("""
                SELECT id FROM t_course_offering
                 WHERE course_id = ? AND term_id = ? AND teacher_id = ?
                """, courseId, tid, teacherId) != null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "该课程在本学期已由该教师开课，不能重复开课");
        }
        List<Map<String, Object>> schedules = asMapList(b.get("schedules"));
        Period.assertValidSchedules(schedules);
        String campus = Api.strOf(b.get("campus"));
        String remark = Api.strOf(b.get("remark"));

        long offeringId = db.withTransaction(() -> {
            long newId = db.insertReturningId("""
                    INSERT INTO t_course_offering
                           (course_id, term_id, teacher_id, capacity, enrolled, status, campus, remark)
                    VALUES (?, ?, ?, ?, 0, 1, ?, ?)
                    """, courseId, tid, teacherId, Db.toLong(capacity), campus, remark);
            for (Map<String, Object> s : schedules) {
                db.update("""
                        INSERT INTO t_course_schedule
                               (offering_id, weekday, start_period, end_period, parity, campus, building, room)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        newId,
                        Api.intOf(s.get("weekday"), 0),
                        Api.intOf(firstNonNull(s.get("startPeriod"), s.get("start_period")), 0),
                        Api.intOf(firstNonNull(s.get("endPeriod"), s.get("end_period")), 0),
                        Api.intOf(s.get("parity"), 0),
                        Api.strOf(s.get("campus")) != null ? Api.strOf(s.get("campus")) : campus,
                        Api.strOf(s.get("building")),
                        Api.strOf(s.get("room")));
            }
            return newId;
        });

        audit.log("OFFERING_CREATE", "OFFERING", offeringId, 1, "容量 " + Db.toLong(capacity));
        return Api.ok(Map.of("offeringId", offeringId), "开课已创建");
    }

    /** 更新开课：容量调整、停开/开放、排课维护；容量扩大后自动触发候补递补 */
    @PutMapping("/offerings/{id}")
    public ApiResponse updateOffering(@PathVariable long id,
                                      @RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Map<String, Object> offering = db.queryOne("SELECT * FROM t_course_offering WHERE id = ?", id);
        if (offering == null) {
            throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
        }

        Object capacityRaw = b.get("capacity");
        long enrolled = Db.num(offering, "enrolled");
        if (capacityRaw != null && Db.toLong(capacityRaw) < enrolled) {
            throw new BizException(ErrorCode.BAD_REQUEST, "容量不能小于已选人数 " + enrolled);
        }
        List<Map<String, Object>> schedules = b.containsKey("schedules") ? asMapList(b.get("schedules")) : null;
        Period.assertValidSchedules(schedules);

        long newCapacity = capacityRaw == null ? Db.num(offering, "capacity") : Db.toLong(capacityRaw);
        long newStatus = b.get("status") == null ? Db.num(offering, "status")
                : Api.intOf(b.get("status"), 1);
        Object campus = b.containsKey("campus") ? b.get("campus") : offering.get("campus");
        Object remark = b.containsKey("remark") ? b.get("remark") : offering.get("remark");

        db.inTransaction(() -> {
            db.update("""
                    UPDATE t_course_offering SET capacity = ?, status = ?, campus = ?, remark = ?
                     WHERE id = ?
                    """, newCapacity, newStatus,
                    campus == null ? null : String.valueOf(campus),
                    remark == null ? null : String.valueOf(remark),
                    id);
            // 容量或状态变化后重新推导"已满"状态
            db.update("""
                    UPDATE t_course_offering SET status = 2
                     WHERE id = ? AND status = 1 AND enrolled >= capacity
                    """, id);
            db.update("""
                    UPDATE t_course_offering SET status = 1
                     WHERE id = ? AND status = 2 AND enrolled < capacity
                    """, id);

            if (schedules != null) {
                db.update("DELETE FROM t_course_schedule WHERE offering_id = ?", id);
                for (Map<String, Object> s : schedules) {
                    db.update("""
                            INSERT INTO t_course_schedule
                                   (offering_id, weekday, start_period, end_period, parity, campus, building, room)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            id,
                            Api.intOf(s.get("weekday"), 0),
                            Api.intOf(firstNonNull(s.get("startPeriod"), s.get("start_period")), 0),
                            Api.intOf(firstNonNull(s.get("endPeriod"), s.get("end_period")), 0),
                            Api.intOf(s.get("parity"), 0),
                            Api.strOf(s.get("campus")),
                            Api.strOf(s.get("building")),
                            Api.strOf(s.get("room")));
                }
            }
        });

        boolean capacityChange = capacityRaw != null && Db.toLong(capacityRaw) != Db.num(offering, "capacity");
        audit.log(capacityChange ? "CAPACITY_ADJUST" : "OFFERING_UPDATE", "OFFERING", id, 1,
                capacityChange
                        ? "容量 " + Db.num(offering, "capacity") + " → " + capacityRaw + "（已选 " + enrolled + "）"
                        : "更新开课信息");

        // 容量扩大后可能释放出名额，触发候补递补
        List<Map<String, Object>> promoted = null;
        if (capacityRaw != null && Db.toLong(capacityRaw) > enrolled) {
            promoted = waitlist.promoteFromOffering(id);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("id", id);
        data.put("promoted", promoted);
        return Api.ok(data, "开课已更新");
    }

    /** 名额管理列表（含候补人数） */
    @GetMapping("/statistics")
    public ApiResponse statistics() {
        Map<String, Object> term = rules.getCurrentTerm();
        List<Map<String, Object>> rows = db.query("""
                SELECT o.id AS offering_id, c.course_code, c.name AS course_name,
                       tu.real_name AS teacher_name,
                       o.capacity, o.enrolled, o.status,
                       ROUND(o.enrolled::numeric / NULLIF(o.capacity, 0) * 100, 1) AS rate,
                       COALESCE(w.cnt, 0) AS waitlist_count
                  FROM t_course_offering o
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_teacher t ON t.id = o.teacher_id
                  JOIN t_user tu ON tu.id = t.user_id
                  LEFT JOIN (SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist
                              WHERE status = 1 GROUP BY offering_id) w ON w.offering_id = o.id
                 WHERE o.term_id = ?
                 ORDER BY rate DESC NULLS LAST, o.enrolled DESC
                """, Db.num(term, "id"));
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("term", term);
        data.put("list", rows);
        return Api.ok(data);
    }

    /* ------------------------------------------------------------------ */
    /* 批次与学分规则                                                       */
    /* ------------------------------------------------------------------ */

    @GetMapping("/batches")
    public ApiResponse batches() {
        Map<String, Object> term = rules.getCurrentTerm();
        List<Map<String, Object>> rows = db.query(
                "SELECT * FROM t_enroll_batch WHERE term_id = ? ORDER BY priority", Db.num(term, "id"));

        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> b : rows) {
            Map<String, Object> m = new LinkedHashMap<>(b);
            m.put("typeText", Db.num(b, "type") == 2 ? "补退选" : "正常选课");
            java.sql.Timestamp start = RuleService.tsOf(b.get("start_time"));
            java.sql.Timestamp end = RuleService.tsOf(b.get("end_time"));
            long now = System.currentTimeMillis();
            String state = start != null && now < start.getTime() ? "未开始"
                    : (end != null && now > end.getTime() ? "已结束" : "进行中");
            m.put("state", state);
            list.add(m);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("term", term);
        data.put("list", list);
        return Api.ok(data);
    }

    @PostMapping("/batches")
    public ApiResponse createBatch(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String name = Api.strOf(b.get("name"));
        String startTime = Api.strOf(b.get("startTime"));
        String endTime = Api.strOf(b.get("endTime"));
        if (name == null || startTime == null || endTime == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "批次名称与起止时间为必填项");
        }
        Map<String, Object> term = rules.getCurrentTerm();
        long id = db.insertReturningId("""
                INSERT INTO t_enroll_batch
                       (term_id, name, type, start_time, end_time, target_grade, target_college, priority, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                Db.num(term, "id"), name, Api.intOf(b.get("type"), 1),
                RuleService.tsOf(startTime), RuleService.tsOf(endTime),
                Api.strOf(b.get("targetGrade")), Api.strOf(b.get("targetCollege")),
                Api.intOf(b.get("priority"), 0));
        audit.log("BATCH_CREATE", "BATCH", id, 1, name);
        return Api.ok(Map.of("id", id), "批次已创建");
    }

    @PutMapping("/batches/{id}")
    public ApiResponse updateBatch(@PathVariable long id,
                                   @RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Map<String, Object> batch = db.queryOne("SELECT * FROM t_enroll_batch WHERE id = ?", id);
        if (batch == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "批次不存在");
        }
        Object startTime = b.get("startTime") != null ? b.get("startTime") : batch.get("start_time");
        Object endTime = b.get("endTime") != null ? b.get("endTime") : batch.get("end_time");

        db.update("""
                UPDATE t_enroll_batch SET name = ?, type = ?, start_time = ?, end_time = ?,
                       target_grade = ?, target_college = ?, priority = ?, status = ?
                 WHERE id = ?
                """,
                b.get("name") != null ? Api.strOf(b.get("name")) : Db.str(batch, "name"),
                b.get("type") != null ? Api.intOf(b.get("type"), 1) : Db.num(batch, "type"),
                RuleService.tsOf(startTime), RuleService.tsOf(endTime),
                b.containsKey("targetGrade") ? Api.strOf(b.get("targetGrade")) : batch.get("target_grade"),
                b.containsKey("targetCollege") ? Api.strOf(b.get("targetCollege"))
                        : batch.get("target_college"),
                b.get("priority") != null ? Api.intOf(b.get("priority"), 0) : Db.num(batch, "priority"),
                b.get("status") != null ? Api.intOf(b.get("status"), 1) : Db.num(batch, "status"),
                id);
        audit.log("BATCH_UPDATE", "BATCH", id, 1,
                b.get("name") != null ? Api.strOf(b.get("name")) : Db.str(batch, "name"));
        return Api.ok(Map.of("id", id), "批次已更新");
    }

    @DeleteMapping("/batches/{id}")
    public ApiResponse deleteBatch(@PathVariable long id) {
        db.update("DELETE FROM t_enroll_batch WHERE id = ?", id);
        audit.log("BATCH_DELETE", "BATCH", id, 1, null);
        return Api.ok(Map.of("id", id), "批次已删除");
    }

    @GetMapping("/credit-rules")
    public ApiResponse creditRules() {
        Map<String, Object> term = rules.getCurrentTerm();
        long termId = Db.num(term, "id");
        List<Map<String, Object>> gradeRules = db.query(
                "SELECT * FROM t_credit_rule WHERE term_id = ? ORDER BY grade", termId);
        List<Map<String, Object>> categoryRules = rules.getCategoryCreditRules(termId);
        List<Map<String, Object>> categories = db.query("SELECT * FROM t_course_category ORDER BY id");

        List<Map<String, Object>> gl = new ArrayList<>();
        for (Map<String, Object> g : gradeRules) {
            Map<String, Object> m = new LinkedHashMap<>(g);
            m.put("min_credit", Db.decimal(g, "min_credit"));
            m.put("max_credit", Db.decimal(g, "max_credit"));
            gl.add(m);
        }
        List<Map<String, Object>> cl = new ArrayList<>();
        for (Map<String, Object> c : categoryRules) {
            Map<String, Object> m = new LinkedHashMap<>(c);
            m.put("min_credit", c.get("min_credit") == null ? null : Db.decimal(c, "min_credit"));
            m.put("max_credit", c.get("max_credit") == null ? null : Db.decimal(c, "max_credit"));
            cl.add(m);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("term", term);
        data.put("gradeRules", gl);
        data.put("categoryRules", cl);
        data.put("categories", categories);
        return Api.ok(data);
    }

    @PostMapping("/credit-rules")
    public ApiResponse saveCreditRule(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String grade = Api.strOf(b.get("grade"));
        if (grade == null || b.get("maxCredit") == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "年级与学分上限为必填项");
        }
        Map<String, Object> term = rules.getCurrentTerm();
        db.update("""
                INSERT INTO t_credit_rule (term_id, grade, min_credit, max_credit) VALUES (?, ?, ?, ?)
                ON CONFLICT (term_id, grade)
                DO UPDATE SET min_credit = EXCLUDED.min_credit, max_credit = EXCLUDED.max_credit
                """, Db.num(term, "id"), grade, Db.decimal(b, "minCredit"), Db.decimal(b, "maxCredit"));
        audit.log("CREDIT_RULE_UPDATE", "TERM", Db.num(term, "id"), 1,
                grade + " 级上限 " + b.get("maxCredit"));
        return Api.ok(Map.of("grade", grade), "学分规则已保存");
    }

    @PostMapping("/category-credit-rules")
    public ApiResponse saveCategoryCreditRule(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Long categoryId = Api.longOf(b.get("categoryId"));
        if (categoryId == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "课程类别为必填项");
        }
        Map<String, Object> term = rules.getCurrentTerm();
        db.update("""
                INSERT INTO t_category_credit_rule (term_id, category_id, min_credit, max_credit)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (term_id, category_id)
                DO UPDATE SET min_credit = EXCLUDED.min_credit, max_credit = EXCLUDED.max_credit
                """, Db.num(term, "id"), categoryId, decimalOrNull(b.get("minCredit")),
                decimalOrNull(b.get("maxCredit")));
        audit.log("CATEGORY_CREDIT_RULE_UPDATE", "TERM", Db.num(term, "id"), 1, null);
        return Api.ok(Map.of("categoryId", categoryId), "类别学分要求已保存");
    }

    /* ------------------------------------------------------------------ */
    /* 公告                                                                */
    /* ------------------------------------------------------------------ */

    @GetMapping("/announcements")
    public ApiResponse announcements() {
        List<Map<String, Object>> rows = db.query("""
                SELECT a.*, u.real_name AS publisher_name FROM t_announcement a
                  JOIN t_user u ON u.id = a.publisher_id ORDER BY a.publish_time DESC LIMIT 50
                """);
        return Api.ok(Map.of("list", rows));
    }

    @PostMapping("/announcements")
    public ApiResponse publish(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String title = Api.strOf(b.get("title"));
        String content = b.get("content") == null ? null : String.valueOf(b.get("content"));
        if (title == null || content == null || content.isBlank()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "公告标题与正文为必填项");
        }
        int status = Boolean.FALSE.equals(b.get("publish")) ? 0 : 1;
        String targetGrade = Api.strOf(b.get("targetGrade"));

        long id = db.withTransaction(() -> {
            long newId = db.insertReturningId("""
                    INSERT INTO t_announcement (publisher_id, title, content, target_scope, publish_time, status)
                    VALUES (?, ?, ?, ?, NOW(), ?)
                    """, CurrentUser.userId(), title, content, Api.strOf(b.get("targetScope")), status);
            if (status == 1) {
                // 向目标范围投递站内通知
                List<Map<String, Object>> users = targetGrade != null
                        ? db.query("""
                                SELECT u.id FROM t_user u JOIN t_student s ON s.user_id = u.id
                                 WHERE u.role = 1 AND s.grade = ?
                                """, targetGrade)
                        : db.query("SELECT id FROM t_user WHERE role = 1");
                for (Map<String, Object> u : users) {
                    notice.send(Db.num(u, "id"), NoticeService.TYPE_ANNOUNCEMENT,
                            "新公告：" + title, content.length() > 200 ? content.substring(0, 200) : content,
                            newId);
                }
            }
            return newId;
        });

        audit.log("ANNOUNCEMENT_PUBLISH", "ANNOUNCEMENT", id, 1, title);
        return Api.ok(Map.of("id", id), status == 1 ? "公告已发布并投递通知" : "公告已保存为草稿");
    }

    @PutMapping("/announcements/{id}/status")
    public ApiResponse updateAnnouncementStatus(@PathVariable long id,
                                                @RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        int status = Api.intOf(b.get("status"), 0);
        db.update("UPDATE t_announcement SET status = ? WHERE id = ?", status, id);
        audit.log("ANNOUNCEMENT_STATUS", "ANNOUNCEMENT", id, 1, "状态 " + status);
        return Api.ok(Map.of("id", id, "status", status), "公告状态已更新");
    }

    /* ------------------------------------------------------------------ */

    private static Object firstNonNull(Object a, Object b) {
        return a != null ? a : b;
    }

    private static java.math.BigDecimal decimalOrNull(Object v) {
        if (v == null) {
            return null;
        }
        String s = String.valueOf(v).trim();
        return s.isEmpty() ? null : new java.math.BigDecimal(s);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> asMapList(Object v) {
        if (v instanceof List<?> list) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Object item : list) {
                if (item instanceof Map<?, ?> m) {
                    Map<String, Object> mm = new LinkedHashMap<>();
                    m.forEach((k, val) -> mm.put(String.valueOf(k), val));
                    out.add(mm);
                }
            }
            return out;
        }
        return List.of();
    }
}
