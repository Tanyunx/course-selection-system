package com.campus.course.common;

import java.util.HashMap;
import java.util.Map;

/**
 * 业务错误码（对应设计文档表 5）。
 *
 * <p>分段约定：0 成功；1001~1003 认证与权限；2001~2014 选课业务；
 * 9001~9003 限速与系统级异常。
 */
public final class ErrorCode {

    private ErrorCode() {
    }

    public static final int SUCCESS = 0;

    /* ---------- 认证与授权 ---------- */
    public static final int LOGIN_FAILED = 1001;
    public static final int TOKEN_INVALID = 1002;
    public static final int NO_PERMISSION = 1003;

    /* ---------- 选课业务 ---------- */
    public static final int CAPACITY_FULL = 2001;
    public static final int TIME_CONFLICT = 2002;
    public static final int CREDIT_EXCEED = 2003;
    public static final int PREREQ_MISSING = 2004;
    public static final int BATCH_OUT_OF_RANGE = 2005;
    public static final int DUPLICATE_ENROLL = 2006;
    public static final int DUPLICATE_WAITLIST = 2007;
    public static final int DROP_DEADLINE_PASSED = 2008;
    public static final int TARGET_NOT_SELECTABLE = 2009;
    public static final int WAITLIST_EXPIRED = 2010;
    public static final int NOT_ENROLLED = 2011;
    public static final int OFFERING_CLOSED = 2012;
    public static final int NOT_IN_WAITLIST = 2013;
    public static final int OFFERING_NOT_FOUND = 2014;

    /* ---------- 系统级 ---------- */
    public static final int RATE_LIMITED = 9001;
    public static final int INTERNAL_ERROR = 9002;
    public static final int BAD_REQUEST = 9003;

    private static final Map<Integer, String> TEXT = new HashMap<>();

    static {
        TEXT.put(SUCCESS, "操作成功");
        TEXT.put(LOGIN_FAILED, "账号或密码错误，请重新输入");
        TEXT.put(TOKEN_INVALID, "登录状态已失效，请重新登录");
        TEXT.put(NO_PERMISSION, "当前角色无此操作权限");

        TEXT.put(CAPACITY_FULL, "该课程名额已满，可加入候补");
        TEXT.put(TIME_CONFLICT, "与已选课程时间冲突");
        TEXT.put(CREDIT_EXCEED, "选课后将超出本学期学分上限");
        TEXT.put(PREREQ_MISSING, "需先修并通过指定先修课程");
        TEXT.put(BATCH_OUT_OF_RANGE, "当前不在你可选的选课批次时间内");
        TEXT.put(DUPLICATE_ENROLL, "你已选该课程，无需重复选课");
        TEXT.put(DUPLICATE_WAITLIST, "你已加入候补");
        TEXT.put(DROP_DEADLINE_PASSED, "已超过退课截止时间，无法退课");
        TEXT.put(TARGET_NOT_SELECTABLE, "目标课程不可选，原课程未变动");
        TEXT.put(WAITLIST_EXPIRED, "候补机会已过期，名额已顺延他人");
        TEXT.put(NOT_ENROLLED, "你尚未选修该课程");
        TEXT.put(OFFERING_CLOSED, "该开课已停开，无法操作");
        TEXT.put(NOT_IN_WAITLIST, "你不在该课程的候补队列中");
        TEXT.put(OFFERING_NOT_FOUND, "未找到对应的开课记录");

        TEXT.put(RATE_LIMITED, "当前访问过于频繁，请稍后再试");
        TEXT.put(INTERNAL_ERROR, "系统繁忙，请稍后重试");
        TEXT.put(BAD_REQUEST, "请求参数有误，请检查后重试");
    }

    public static String text(int code) {
        String s = TEXT.get(code);
        return s == null ? "操作失败" : s;
    }
}
