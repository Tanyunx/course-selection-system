package com.campus.course.web;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.campus.course.common.Api;
import com.campus.course.common.ApiResponse;
import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.db.Db;
import com.campus.course.security.CurrentUser;
import com.campus.course.security.RequireRole;
import com.campus.course.security.Role;
import com.campus.course.service.AccountService;
import com.campus.course.service.AuditService;
import com.campus.course.service.CourseService;
import com.campus.course.service.RuleService;
import com.campus.course.util.Period;

/**
 * 教师端接口（对应设计文档 3.3、表 4，等价于原 Node 版的 routes/teacher.js）。
 *
 * <p>教师可维护本人开课的上课时间与地点；容量由教务设定，教师不可修改。
 * 教务管理员在本组接口中拥有只读全部开课的权限（便于代教师排课），但不能改他人排课。
 */
@RestController
@RequestMapping("/api/teacher")
@RequireRole({Role.TEACHER, Role.ACADEMIC_ADMIN})
public class TeacherController {

    private final Db db;
    private final RuleService rules;
    private final CourseService courses;
    private final AccountService account;
    private final AuditService audit;

    public TeacherController(Db db, RuleService rules, CourseService courses,
                             AccountService account, AuditService audit) {
        this.db = db;
        this.rules = rules;
        this.courses = courses;
        this.account = account;
        this.audit = audit;
    }

    /** 我的开课列表（含排课、余量、热度、候补人数） */
    @GetMapping("/offerings")
    public ApiResponse offerings() {
        Map<String, Object> term = rules.getCurrentTerm();

        List<Long> teacherIds = new ArrayList<>();
        if (CurrentUser.role() == Role.TEACHER) {
            Map<String, Object> teacher = account.getTeacherByUserId(CurrentUser.userId());
            if (teacher == null) {
                throw new BizException(ErrorCode.NO_PERMISSION, "未找到教师档案");
            }
            teacherIds.add(Db.num(teacher, "id"));
        } else {
            for (Map<String, Object> t : db.query("SELECT id FROM t_teacher")) {
                teacherIds.add(Db.num(t, "id"));
            }
        }

        List<Map<String, Object>> rows = db.query("""
                SELECT o.id AS offering_id, o.capacity, o.enrolled, o.status, o.campus, o.remark,
                       c.course_code, c.name AS course_name, c.credit, cat.name AS category_name,
                       tu.real_name AS teacher_name
                  FROM t_course_offering o
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_course_category cat ON cat.id = c.category_id
                  JOIN t_teacher t ON t.id = o.teacher_id
                  JOIN t_user tu ON tu.id = t.user_id
                 WHERE o.term_id = ? AND o.teacher_id IN (?)
                 ORDER BY c.course_code
                """, Db.num(term, "id"), teacherIds);
        courses.attachSchedules(rows);

        Map<Long, Long> countMap = new LinkedHashMap<>();
        if (!rows.isEmpty()) {
            List<Long> ids = new ArrayList<>();
            for (Map<String, Object> r : rows) {
                ids.add(Db.num(r, "offering_id"));
            }
            for (Map<String, Object> c : db.query("""
                    SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist
                     WHERE status = 1 AND offering_id IN (?) GROUP BY offering_id
                    """, ids)) {
                countMap.put(Db.num(c, "offering_id"), Db.num(c, "cnt"));
            }
        }

        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("offeringId", Db.num(r, "offering_id"));
            m.put("courseCode", r.get("course_code"));
            m.put("courseName", r.get("course_name"));
            m.put("credit", Db.decimal(r, "credit"));
            m.put("categoryName", r.get("category_name"));
            m.put("teacherName", r.get("teacher_name"));
            m.put("capacity", Db.num(r, "capacity"));
            m.put("enrolled", Db.num(r, "enrolled"));
            m.put("remaining", Math.max(0, Db.num(r, "capacity") - Db.num(r, "enrolled")));
            m.put("heat", RuleService.heatOf(Db.num(r, "enrolled"), Db.num(r, "capacity")));
            m.put("status", Db.num(r, "status"));
            m.put("campus", r.get("campus"));
            m.put("remark", r.get("remark"));
            m.put("schedules", r.get("schedules"));
            m.put("scheduleText", r.get("scheduleText"));
            m.put("waitlistCount", countMap.getOrDefault(Db.num(r, "offering_id"), 0L));
            list.add(m);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("term", term);
        data.put("list", list);
        return Api.ok(data);
    }

    /** 维护上课时间与地点（整体替换该开课的排课时段） */
    @PutMapping("/offerings/{id}")
    public ApiResponse updateOffering(@PathVariable long id,
                                      @RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Map<String, Object> offering = db.queryOne("SELECT * FROM t_course_offering WHERE id = ?", id);
        if (offering == null) {
            throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
        }
        if (CurrentUser.role() == Role.TEACHER) {
            Map<String, Object> teacher = account.getTeacherByUserId(CurrentUser.userId());
            if (teacher == null || Db.num(teacher, "id") != Db.num(offering, "teacher_id")) {
                throw new BizException(ErrorCode.NO_PERMISSION, "只能维护本人的开课");
            }
        }

        List<Map<String, Object>> schedules = asMapList(b.get("schedules"));
        Period.assertValidSchedules(schedules);

        db.inTransaction(() -> {
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
            if (b.containsKey("remark")) {
                db.update("UPDATE t_course_offering SET remark = ? WHERE id = ?",
                        AuditService.truncate(b.get("remark") == null ? null : String.valueOf(b.get("remark")), 200),
                        id);
            }
        });

        audit.log("TEACHER_UPDATE_SCHEDULE", "OFFERING", id, 1,
                "维护排课：共 " + schedules.size() + " 个时段");
        return Api.ok(Map.of("offeringId", id, "scheduleCount", schedules.size()),
                "上课时间与地点已保存");
    }

    /** 选课学生名单与候补队列 */
    @GetMapping("/offerings/{id}/students")
    public ApiResponse students(@PathVariable long id) {
        Map<String, Object> offering = db.queryOne("SELECT * FROM t_course_offering WHERE id = ?", id);
        if (offering == null) {
            throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
        }
        if (CurrentUser.role() == Role.TEACHER) {
            Map<String, Object> teacher = account.getTeacherByUserId(CurrentUser.userId());
            if (teacher == null || Db.num(teacher, "id") != Db.num(offering, "teacher_id")) {
                throw new BizException(ErrorCode.NO_PERMISSION, "只能查看本人开课名单");
            }
        }

        List<Map<String, Object>> students = db.query("""
                SELECT s.student_no, u.real_name, s.grade, s.college, s.major,
                       e.select_time, e.source,
                       CASE e.source WHEN 2 THEN '候补递补' ELSE '正常选课' END AS source_text
                  FROM t_enrollment e
                  JOIN t_student s ON s.id = e.student_id
                  JOIN t_user u ON u.id = s.user_id
                 WHERE e.offering_id = ? AND e.status = 1
                 ORDER BY e.select_time
                """, id);

        List<Map<String, Object>> waitlist = db.query("""
                SELECT w.queue_no, s.student_no, u.real_name, w.join_time, w.status
                  FROM t_waitlist w
                  JOIN t_student s ON s.id = w.student_id
                  JOIN t_user u ON u.id = s.user_id
                 WHERE w.offering_id = ? AND w.status IN (1, 2)
                 ORDER BY w.queue_no
                """, id);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("students", students);
        data.put("waitlist", waitlist);
        data.put("capacity", Db.num(offering, "capacity"));
        data.put("enrolled", Db.num(offering, "enrolled"));
        return Api.ok(data);
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

    private static Object firstNonNull(Object a, Object b) {
        return a != null ? a : b;
    }
}
