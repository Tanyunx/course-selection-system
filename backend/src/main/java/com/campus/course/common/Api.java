package com.campus.course.common;

import java.util.List;
import java.util.Map;

import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import com.campus.course.store.MetricsStore;

import jakarta.servlet.http.HttpServletRequest;

/**
 * Controller 层的统一返回工具。
 *
 * <p>存在的意义有两个：
 * <ol>
 *   <li>把"构造返回体"和"记录运行指标"绑在一起——原 Node 版用中间件包装
 *       {@code res.json} 采集错误码，Java 侧改在这里采集，效果等价且更直观；</li>
 *   <li>统一分页结构，避免每个列表接口各写一份。</li>
 * </ol>
 *
 * <p>计时以 {@link #markStart} 在 Controller 进入时记为起点（由
 * {@code ApiTimingInterceptor} 写入请求属性）。
 */
public final class Api {

    private Api() {
    }

    public static final String START_ATTR = Api.class.getName() + ".startAt";

    /** 归一化后的接口路径（把 /courses/12 这类具体值收敛成 /courses/:id），仅供监控聚合展示 */
    public static final String PATH_ATTR = Api.class.getName() + ".path";

    public static ApiResponse ok(Object data) {
        return ok(data, null);
    }

    public static ApiResponse ok(Object data, String message) {
        ApiResponse resp = new ApiResponse(ErrorCode.SUCCESS,
                message == null ? "操作成功" : message, data);
        record(resp);
        return resp;
    }

    public static ApiResponse ok() {
        return ok(null, null);
    }

    /** 分页返回体，字段名与前端约定一致：total / page / size / list。 */
    public static ApiResponse page(List<?> list, long total, int page, int size) {
        return ok(ApiResponse.page(list, total, page, size));
    }

    /** 失败返回体（业务异常由 GlobalExceptionHandler 构造，这里供个别分支直接使用）。 */
    public static ApiResponse fail(int code, String message, Object data) {
        ApiResponse resp = ApiResponse.fail(code, message, data);
        record(resp);
        return resp;
    }

    /** 把本次请求计入指标；无请求上下文（如定时任务）时静默跳过。 */
    private static void record(ApiResponse resp) {
        MetricsStore metrics = MetricsStore.get();
        if (metrics == null) {
            return;
        }
        ServletRequestAttributes attrs =
                (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        if (attrs == null) {
            return;
        }
        HttpServletRequest req = attrs.getRequest();
        Object started = req.getAttribute(START_ATTR);
        long cost = started instanceof Long l ? System.currentTimeMillis() - l : 0L;

        String path = (String) req.getAttribute(PATH_ATTR);
        if (path == null) {
            path = req.getRequestURI();
        }
        metrics.record(req.getMethod(), path, resp.getCode(), cost);
    }

    /** 便捷取 Map 中的整型值（业务代码里大量存在） */
    public static int intOf(Object v, int fallback) {
        if (v == null) {
            return fallback;
        }
        if (v instanceof Number n) {
            return n.intValue();
        }
        try {
            return Integer.parseInt(String.valueOf(v).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    /** 便捷取 Map 中的长整型值 */
    public static Long longOf(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Number n) {
            return n.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(v).trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 便捷取 Map 中的布尔值（前端可能传 true / "true" / 1） */
    public static boolean boolOf(Object v) {
        if (v == null) {
            return false;
        }
        if (v instanceof Boolean b) {
            return b;
        }
        if (v instanceof Number n) {
            return n.intValue() != 0;
        }
        return "true".equalsIgnoreCase(String.valueOf(v).trim());
    }

    /** 便捷取 Map 中的字符串，null 安全且会去掉首尾空白 */
    public static String strOf(Object v) {
        if (v == null) {
            return null;
        }
        String s = String.valueOf(v).trim();
        return s.isEmpty() ? null : s;
    }

    /** 供 Service 复用的空分页体 */
    public static Map<String, Object> emptyPage(int page, int size) {
        return Map.of("total", 0L, "page", page, "size", size, "pageSize", size, "list", List.of());
    }
}
