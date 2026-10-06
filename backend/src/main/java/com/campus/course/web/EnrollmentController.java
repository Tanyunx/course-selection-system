package com.campus.course.web;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
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
import com.campus.course.service.AccountService;
import com.campus.course.service.CourseService;
import com.campus.course.service.EnrollmentService;
import com.campus.course.service.Guard;
import com.campus.course.service.RuleService;

/**
 * 选课、退课、换课与我的已选
 * （对应设计文档表 4、6.1、6.2、6.3，等价于原 Node 版的 routes/enrollments.js）。
 *
 * <p>三个写接口都挂了限速与幂等：限速防脚本刷课，幂等保证"网络重发 / 用户连点"
 * 不会重复扣减名额。
 */
@RestController
@RequestMapping("/api")
@RequireRole(Role.STUDENT)
public class EnrollmentController {

    private final EnrollmentService enrollment;
    private final CourseService courses;
    private final RuleService rules;
    private final AccountService account;
    private final Guard guard;
    private final Db db;

    public EnrollmentController(EnrollmentService enrollment, CourseService courses,
                                RuleService rules, AccountService account, Guard guard, Db db) {
        this.enrollment = enrollment;
        this.courses = courses;
        this.rules = rules;
        this.account = account;
        this.guard = guard;
        this.db = db;
    }

    /** 取当前登录用户的学生档案；缺失说明账号未建档案 */
    private Map<String, Object> currentStudent() {
        Map<String, Object> student = account.getStudentByUserId(CurrentUser.userId());
        if (student == null) {
            throw new BizException(ErrorCode.NO_PERMISSION, "未找到学生档案，请联系教务管理员");
        }
        return student;
    }

    /** 选课 */
    @PostMapping("/enrollments")
    public ApiResponse enroll(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Long offeringId = Api.longOf(b.get("offeringId"));
        if (offeringId == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "缺少 offeringId");
        }
        Map<String, Object> student = currentStudent();
        guard.rateLimited();
        return guard.idempotent(b.get("requestId"), () ->
                Api.ok(enrollment.enroll(student, offeringId), "选课成功"));
    }

    /** 退课 */
    @DeleteMapping("/enrollments/{offeringId}")
    public ApiResponse drop(@PathVariable long offeringId,
                            @RequestParam(required = false) String requestId,
                            @RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> student = currentStudent();
        guard.rateLimited();
        Object rid = requestId != null ? requestId : (body == null ? null : body.get("requestId"));
        return guard.idempotent(rid, () -> {
            Map<String, Object> data = enrollment.drop(student, offeringId);
            Object promoted = data.get("promoted");
            boolean hasPromoted = promoted instanceof List<?> l && !l.isEmpty();
            return Api.ok(data, hasPromoted ? "退课成功，名额已递补给候补同学" : "退课成功");
        });
    }

    /** 换课（先占后放，单一事务） */
    @PostMapping("/enrollments/switch")
    public ApiResponse switchCourse(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Long from = Api.longOf(b.get("fromOfferingId"));
        Long to = Api.longOf(b.get("toOfferingId"));
        if (from == null || to == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "缺少 fromOfferingId 或 toOfferingId");
        }
        Map<String, Object> student = currentStudent();
        guard.rateLimited();
        return guard.idempotent(b.get("requestId"), () ->
                Api.ok(enrollment.switchCourse(student, from, to), "换课成功"));
    }

    /** 我的已选课程 */
    @GetMapping("/enrollments/mine")
    public ApiResponse mine(@RequestParam(required = false) Long termId) {
        Map<String, Object> student = currentStudent();
        long current = termId != null ? termId : Db.num(rules.getCurrentTerm(), "id");
        List<Map<String, Object>> list = enrollment.myEnrollments(student, current);
        CourseService.StudentContext ctx = courses.buildStudentContext(student, current);

        Map<String, Object> credit = new LinkedHashMap<>();
        credit.put("total", ctx.creditSummary.total());
        credit.put("byCategory", ctx.creditSummary.byCategory());
        credit.put("rule", ctx.creditRule);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("list", list);
        data.put("totalCredit", ctx.creditSummary.total());
        data.put("byCategory", ctx.creditSummary.byCategory());
        data.put("creditRule", ctx.creditRule);
        data.put("categoryRules", ctx.categoryRules);
        data.put("batch", ctx.batchInfo.batch());
        data.put("nextBatch", ctx.batchInfo.next());
        data.put("dropDeadline", ctx.dropDeadline);
        return Api.ok(data);
    }

    /** 我的课表（支持单双周切换） */
    @GetMapping("/timetable")
    public ApiResponse timetable(@RequestParam(required = false) Long termId,
                                 @RequestParam(required = false) Integer parity) {
        Map<String, Object> student = currentStudent();
        long current = termId != null ? termId : Db.num(rules.getCurrentTerm(), "id");
        Map<String, Object> data = enrollment.timetable(student, current, parity);
        CourseService.StudentContext ctx = courses.buildStudentContext(student, current);

        // 注意：与原实现一致，课表接口的 weekdays 是纯文案数组（前端表头直接用），
        // 与 /api/meta/filters 里带 value/label 的结构不同
        List<String> weekdays = new java.util.ArrayList<>();
        for (int n = 1; n <= 7; n++) {
            weekdays.add(CourseService.weekdayText(n));
        }

        Map<String, Object> result = new LinkedHashMap<>(data);
        result.put("weekdays", weekdays);
        result.put("creditRule", ctx.creditRule);
        return Api.ok(result);
    }
}
