package com.campus.course.web;

import java.util.LinkedHashMap;
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
import com.campus.course.service.Guard;
import com.campus.course.service.RuleService;
import com.campus.course.service.WaitlistService;

/**
 * 候补接口（对应设计文档表 4、4.6 候补递补规则，等价于原 Node 版的 routes/waitlist.js）。
 */
@RestController
@RequestMapping("/api")
@RequireRole(Role.STUDENT)
public class WaitlistController {

    private final WaitlistService waitlist;
    private final RuleService rules;
    private final AccountService account;
    private final Guard guard;
    private final Db db;

    public WaitlistController(WaitlistService waitlist, RuleService rules, AccountService account,
                              Guard guard, Db db) {
        this.waitlist = waitlist;
        this.rules = rules;
        this.account = account;
        this.guard = guard;
        this.db = db;
    }

    private Map<String, Object> currentStudent() {
        Map<String, Object> student = account.getStudentByUserId(CurrentUser.userId());
        if (student == null) {
            throw new BizException(ErrorCode.NO_PERMISSION, "未找到学生档案，请联系教务管理员");
        }
        return student;
    }

    /** 加入候补 */
    @PostMapping("/waitlist")
    public ApiResponse join(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        Long offeringId = Api.longOf(b.get("offeringId"));
        if (offeringId == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "缺少 offeringId");
        }
        Map<String, Object> student = currentStudent();
        guard.rateLimited();
        return guard.idempotent(b.get("requestId"), () -> {
            Map<String, Object> data = waitlist.join(student, offeringId);
            return Api.ok(data, "已加入候补，当前排位第 " + data.get("queueNo") + " 位");
        });
    }

    /** 取消候补 */
    @DeleteMapping("/waitlist/{offeringId}")
    public ApiResponse cancel(@PathVariable long offeringId,
                              @RequestParam(required = false) String requestId) {
        Map<String, Object> student = currentStudent();
        return guard.idempotent(requestId, () ->
                Api.ok(waitlist.cancel(student, offeringId), "已取消候补"));
    }

    /** 确认递补名额 */
    @PostMapping("/waitlist/{offeringId}/confirm")
    public ApiResponse confirm(@PathVariable long offeringId) {
        return Api.ok(waitlist.confirm(currentStudent(), offeringId), "已确认递补名额");
    }

    /** 我的候补与当前排位 */
    @GetMapping("/waitlist/mine")
    public ApiResponse mine(@RequestParam(required = false) Long termId) {
        Map<String, Object> student = currentStudent();
        long current = termId != null ? termId : Db.num(rules.getCurrentTerm(), "id");
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("list", waitlist.mine(student, current));
        data.put("waitlistConfirmHours", 24);
        return Api.ok(data);
    }
}
