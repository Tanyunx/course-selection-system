package com.campus.course.common;

/**
 * 业务异常：携带错误码与可选的补充数据（如冲突课程名）。
 *
 * <p>Service 层直接抛出，由 {@link GlobalExceptionHandler} 统一转成返回体。
 * 抛出后当前事务整体回滚（见 EnrollmentService 的"先占后放"等场景）。
 */
public class BizException extends RuntimeException {

    private final int code;
    private final transient Object data;

    public BizException(int code) {
        this(code, ErrorCode.text(code), null);
    }

    public BizException(int code, String message) {
        this(code, message, null);
    }

    public BizException(int code, String message, Object data) {
        super(message == null ? ErrorCode.text(code) : message);
        this.code = code;
        this.data = data;
    }

    public int getCode() {
        return code;
    }

    public Object getData() {
        return data;
    }
}
