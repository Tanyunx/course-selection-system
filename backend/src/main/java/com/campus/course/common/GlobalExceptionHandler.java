package com.campus.course.common;

import java.util.LinkedHashMap;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;

import com.campus.course.store.MetricsStore;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 全局异常处理（等价于原 Node 版 app.js 里的兜底错误处理 + middleware/auth.js 的 wrap）。
 *
 * <p>约定：业务失败一律返回 HTTP 200 + 非 0 的 code，只有"接口不存在"这类路由级错误
 * 才用 4xx（与原实现保持一致，前端 api.js 只解析返回体中的 code）。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /** 业务异常：携带错误码与补充数据，HTTP 200 */
    @ExceptionHandler(BizException.class)
    public ApiResponse handleBiz(BizException e) {
        ApiResponse resp = ApiResponse.fail(e.getCode(), e.getMessage(), e.getData());
        record(resp);
        return resp;
    }

    /** 接口不存在：9003 + HTTP 404，与原 Node 版的兜底路由一致 */
    @ExceptionHandler(NoHandlerFoundException.class)
    public ResponseEntity<ApiResponse> handleNoHandler(NoHandlerFoundException e,
                                                       HttpServletRequest req) {
        ApiResponse resp = ApiResponse.fail(ErrorCode.BAD_REQUEST, ErrorCode.text(ErrorCode.BAD_REQUEST), null);
        record(resp);
        log.debug("接口不存在：{} {}", req.getMethod(), req.getRequestURI());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(resp);
    }

    /** 请求方式不支持 */
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ApiResponse handleMethod(HttpRequestMethodNotSupportedException e) {
        ApiResponse resp = ApiResponse.fail(ErrorCode.BAD_REQUEST,
                "请求方式不支持：" + e.getMethod(), null);
        record(resp);
        return resp;
    }

    /** 参数缺失 / 类型不匹配 / 报文不可解析，统一按 9003 处理 */
    @ExceptionHandler({
            MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class,
            HttpMessageNotReadableException.class,
    })
    public ApiResponse handleBadRequest(Exception e) {
        ApiResponse resp = ApiResponse.fail(ErrorCode.BAD_REQUEST, ErrorCode.text(ErrorCode.BAD_REQUEST), null);
        record(resp);
        return resp;
    }

    /** @Valid 校验失败，把第一条字段错误作为提示文案 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ApiResponse handleValidation(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(f -> f.getField() + " " + f.getDefaultMessage())
                .orElse(ErrorCode.text(ErrorCode.BAD_REQUEST));
        ApiResponse resp = ApiResponse.fail(ErrorCode.BAD_REQUEST, msg, null);
        record(resp);
        return resp;
    }

    /** 兜底：未知异常按 9002 返回，不把堆栈暴露给前端 */
    @ExceptionHandler(Exception.class)
    public ApiResponse handleOther(Exception e, HttpServletRequest req) {
        log.error("未处理异常 {} {}", req.getMethod(), req.getRequestURI(), e);
        ApiResponse resp = ApiResponse.fail(ErrorCode.INTERNAL_ERROR, null, null);
        record(resp);
        return resp;
    }

    private void record(ApiResponse resp) {
        MetricsStore metrics = MetricsStore.get();
        if (metrics == null) {
            return;
        }
        var attrs = org.springframework.web.context.request.RequestContextHolder.getRequestAttributes();
        if (attrs instanceof org.springframework.web.context.request.ServletRequestAttributes sa) {
            HttpServletRequest req = sa.getRequest();
            Object started = req.getAttribute(Api.START_ATTR);
            long cost = started instanceof Long l ? System.currentTimeMillis() - l : 0L;
            String path = (String) req.getAttribute(Api.PATH_ATTR);
            metrics.record(req.getMethod(), path == null ? req.getRequestURI() : path, resp.getCode(), cost);
        }
    }

    /** 便于个别地方直接构造带 data 的失败体 */
    public static Map<String, Object> data(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }
}
