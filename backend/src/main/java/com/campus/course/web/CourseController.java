package com.campus.course.web;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.campus.course.common.Api;
import com.campus.course.common.ApiResponse;
import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.db.Db;
import com.campus.course.security.CurrentUser;
import com.campus.course.security.Role;
import com.campus.course.service.AccountService;
import com.campus.course.service.CourseService;
import com.campus.course.service.RuleService;

/**
 * 课程查询接口（对应设计文档表 4、3.2.2 课程查询与浏览页，等价于原 Node 版的 routes/courses.js）。
 *
 * <p>返回字段中既有数据库原样的 snake_case（如 credit、capacity），
 * 也有前端直接使用的 camelCase（如 offeringId、scheduleText、selectable），
 * 逐字段与原实现保持一致，前端无需改动。
 */
@RestController
@RequestMapping("/api")
public class CourseController {

    private final Db db;
    private final RuleService rules;
    private final CourseService courses;
    private final AccountService account;

    public CourseController(Db db, RuleService rules, CourseService courses, AccountService account) {
        this.db = db;
        this.rules = rules;
        this.courses = courses;
        this.account = account;
    }

    /** 当前学期与全部学期列表 */
    @GetMapping("/terms/current")
    public ApiResponse currentTerm() {
        Map<String, Object> term = rules.getCurrentTerm();
        List<Map<String, Object>> all = db.query("SELECT * FROM t_term ORDER BY start_date DESC");
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("current", term);
        data.put("terms", all);
        return Api.ok(data);
    }

    /** 筛选项元数据：类别、校区、星期、单双周（前端筛选区使用） */
    @GetMapping("/meta/filters")
    public ApiResponse filters() {
        List<Map<String, Object>> categories = db.query("SELECT * FROM t_course_category ORDER BY id");
        List<Map<String, Object>> campuses = db.query("""
                SELECT DISTINCT campus FROM t_course_offering
                 WHERE campus IS NOT NULL AND campus <> '' ORDER BY campus
                """);

        List<Map<String, Object>> categoryList = new ArrayList<>();
        for (Map<String, Object> c : categories) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("value", Db.num(c, "id"));
            m.put("label", c.get("name"));
            m.put("code", c.get("code"));
            categoryList.add(m);
        }
        List<Object> campusList = new ArrayList<>();
        for (Map<String, Object> c : campuses) {
            campusList.add(c.get("campus"));
        }
        List<Map<String, Object>> weekdays = new ArrayList<>();
        for (int n = 1; n <= 7; n++) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("value", n);
            m.put("label", CourseService.weekdayText(n));
            weekdays.add(m);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("categories", categoryList);
        data.put("campuses", campusList);
        data.put("weekdays", weekdays);
        data.put("parities", List.of(
                Map.of("value", 0, "label", "全周"),
                Map.of("value", 1, "label", "单周"),
                Map.of("value", 2, "label", "双周")));
        return Api.ok(data);
    }

    /**
     * 课程查询：支持 termId、keyword、categoryId、weekday、available、campus、status、page、size、sort。
     * 学生视角额外标注本人可选状态（表 6），其他角色只返回基础信息。
     */
    @GetMapping("/courses")
    public ApiResponse list(@RequestParam Map<String, String> q) {
        Map<String, Object> term = rules.getCurrentTerm();
        long termId = Api.longOf(q.get("termId")) != null
                ? Api.longOf(q.get("termId"))
                : (term == null ? 0L : Db.num(term, "id"));
        int pageNo = Math.max(1, Api.intOf(q.get("page"), 1));
        int size = Math.min(Api.intOf(q.get("size"), 10), 50);

        Integer status = (q.get("status") == null || q.get("status").isBlank())
                ? null : Api.intOf(q.get("status"), 0);
        Integer weekday = (q.get("weekday") == null || q.get("weekday").isBlank())
                ? null : Api.intOf(q.get("weekday"), 0);

        CourseService.QueryResult result = courses.queryOfferings(new CourseService.QueryParams(
                termId,
                blankToNull(q.get("keyword")),
                Api.longOf(q.get("categoryId")),
                weekday,
                "true".equalsIgnoreCase(String.valueOf(q.get("available"))),
                blankToNull(q.get("campus")),
                status,
                pageNo,
                size,
                blankToNull(q.get("sort"))));

        List<Map<String, Object>> rows = result.rows();
        courses.attachSchedules(rows);

        if (CurrentUser.role() == Role.STUDENT) {
            Map<String, Object> student = account.getStudentByUserId(CurrentUser.userId());
            if (student != null) {
                courses.annotateOfferings(rows, courses.buildStudentContext(student, termId));
            }
        }

        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("offeringId", Db.num(r, "offering_id"));
            m.put("courseId", Db.num(r, "course_id"));
            m.put("courseCode", r.get("course_code"));
            m.put("courseName", r.get("course_name"));
            m.put("credit", Db.decimal(r, "credit"));
            m.put("categoryId", Db.num(r, "category_id"));
            m.put("categoryName", r.get("category_name"));
            m.put("dept", r.get("dept"));
            m.put("description", r.get("description"));
            m.put("teacherName", r.get("teacher_name"));
            m.put("teacherTitle", r.get("teacher_title"));
            m.put("capacity", Db.num(r, "capacity"));
            m.put("enrolled", Db.num(r, "enrolled"));
            m.put("remaining", r.get("remaining"));
            m.put("heat", r.get("heat"));
            m.put("offeringStatus", Db.num(r, "offering_status"));
            m.put("campus", r.get("offering_campus"));
            m.put("remark", r.get("remark"));
            m.put("schedules", r.get("schedules"));
            m.put("scheduleText", r.get("scheduleText"));
            m.put("status", r.get("status"));
            m.put("selectable", r.get("selectable"));
            m.put("waitlistable", r.get("waitlistable"));
            m.put("reasons", r.get("reasons"));
            m.put("conflicts", r.get("conflicts"));
            m.put("missingPrereq", r.get("missingPrereq"));
            m.put("myEnrollment", r.get("myEnrollment"));
            m.put("myWaitlist", r.get("myWaitlist"));
            m.put("waitlistCount", r.get("waitlistCount"));
            m.put("willTotalCredit", r.get("willTotalCredit"));
            list.add(m);
        }
        return Api.page(list, result.total(), pageNo, size);
    }

    /** 开课详情：含排课、余量、热度、先修要求、候补队列与本人可选状态 */
    @GetMapping("/courses/{offeringId}")
    public ApiResponse detail(@PathVariable long offeringId) {
        Map<String, Object> term = rules.getCurrentTerm();
        if (term == null) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "系统未配置当前学期");
        }
        long termId = Db.num(term, "id");

        if (CurrentUser.role() == Role.STUDENT) {
            Map<String, Object> student = account.getStudentByUserId(CurrentUser.userId());
            if (student == null) {
                throw new BizException(ErrorCode.NO_PERMISSION, "未找到学生档案");
            }
            CourseService.StudentContext ctx = courses.buildStudentContext(student, termId);
            Map<String, Object> d = courses.getOfferingDetail(offeringId, ctx);
            if (d == null) {
                throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
            }
            return Api.ok(studentDetailPayload(d, ctx));
        }

        List<Map<String, Object>> rows = db.query("""
                SELECT o.*, c.course_code, c.name AS course_name, c.credit, c.dept, c.description,
                       cat.name AS category_name, tu.real_name AS teacher_name, t.title AS teacher_title
                  FROM t_course_offering o
                  JOIN t_course c ON c.id = o.course_id
                  JOIN t_course_category cat ON cat.id = c.category_id
                  JOIN t_teacher t ON t.id = o.teacher_id
                  JOIN t_user tu ON tu.id = t.user_id
                 WHERE o.id = ?
                """, offeringId);
        if (rows.isEmpty()) {
            throw new BizException(ErrorCode.OFFERING_NOT_FOUND);
        }
        Map<String, Object> o = rows.get(0);
        List<Map<String, Object>> schedules = db.query("""
                SELECT * FROM t_course_schedule WHERE offering_id = ? ORDER BY weekday, start_period
                """, offeringId);
        List<String> texts = new ArrayList<>();
        for (Map<String, Object> s : schedules) {
            texts.add(CourseService.scheduleText(s));
        }

        Map<String, Object> offering = new LinkedHashMap<>();
        offering.put("offeringId", Db.num(o, "id"));
        offering.put("courseCode", o.get("course_code"));
        offering.put("courseName", o.get("course_name"));
        offering.put("credit", Db.decimal(o, "credit"));
        offering.put("categoryName", o.get("category_name"));
        offering.put("dept", o.get("dept"));
        offering.put("description", o.get("description"));
        offering.put("teacherName", o.get("teacher_name"));
        offering.put("teacherTitle", o.get("teacher_title"));
        offering.put("capacity", Db.num(o, "capacity"));
        offering.put("enrolled", Db.num(o, "enrolled"));
        offering.put("remaining", Math.max(0, Db.num(o, "capacity") - Db.num(o, "enrolled")));
        offering.put("heat", RuleService.heatOf(Db.num(o, "enrolled"), Db.num(o, "capacity")));
        offering.put("campus", o.get("campus"));
        offering.put("remark", o.get("remark"));
        offering.put("schedules", schedules);
        offering.put("scheduleText", texts);
        offering.put("prereqList", List.of());
        offering.put("waitlistQueue", List.of());

        return Api.ok(Map.of("offering", offering));
    }

    private Map<String, Object> studentDetailPayload(Map<String, Object> d, CourseService.StudentContext ctx) {
        Map<String, Object> offering = new LinkedHashMap<>();
        offering.put("offeringId", Db.num(d, "offering_id"));
        offering.put("courseCode", d.get("course_code"));
        offering.put("courseName", d.get("course_name"));
        offering.put("credit", Db.decimal(d, "credit"));
        offering.put("categoryName", d.get("category_name"));
        offering.put("dept", d.get("dept"));
        offering.put("description", d.get("description"));
        offering.put("teacherName", d.get("teacher_name"));
        offering.put("teacherTitle", d.get("teacher_title"));
        offering.put("teacherCollege", d.get("teacher_college"));
        offering.put("capacity", Db.num(d, "capacity"));
        offering.put("enrolled", Db.num(d, "enrolled"));
        offering.put("remaining", d.get("remaining"));
        offering.put("heat", d.get("heat"));
        offering.put("campus", d.get("offering_campus"));
        offering.put("remark", d.get("remark"));
        offering.put("schedules", d.get("schedules"));
        offering.put("scheduleText", d.get("scheduleText"));
        offering.put("prereqList", d.get("prereqList"));
        offering.put("waitlistQueue", d.get("waitlistQueue"));

        Map<String, Object> state = new LinkedHashMap<>();
        state.put("status", d.get("status"));
        state.put("selectable", d.get("selectable"));
        state.put("waitlistable", d.get("waitlistable"));
        state.put("reasons", d.get("reasons"));
        state.put("conflicts", d.get("conflicts"));
        state.put("myEnrollment", d.get("myEnrollment"));
        state.put("myWaitlist", d.get("myWaitlist"));
        state.put("waitlistCount", d.get("waitlistCount"));
        state.put("willTotalCredit", d.get("willTotalCredit"));
        state.put("missingPrereq", d.get("missingPrereq"));

        Map<String, Object> credit = new LinkedHashMap<>();
        credit.put("total", ctx.creditSummary.total());
        credit.put("byCategory", ctx.creditSummary.byCategory());
        credit.put("rule", ctx.creditRule);

        Map<String, Object> context = new LinkedHashMap<>();
        context.put("batch", ctx.batchInfo.batch());
        context.put("nextBatch", ctx.batchInfo.next());
        context.put("credit", credit);
        context.put("categoryRules", ctx.categoryRules);
        context.put("dropDeadline", ctx.dropDeadline);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("offering", offering);
        data.put("studentState", state);
        data.put("context", context);
        return data;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
