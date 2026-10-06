package com.campus.course.service;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

import org.springframework.stereotype.Service;

import com.campus.course.common.ApiResponse;
import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.security.CurrentUser;
import com.campus.course.store.IdempotencyStore;
import com.campus.course.store.RateLimitStore;

/**
 * 写操作守卫：幂等去重（设计文档 2.4）与防脚本限速（4.5）。
 * 等价于原 Node 版的 middleware/guards.js，只是从"中间件包装 res.json"
 * 改成了"显式包住业务回调"——Java 侧不需要为了拿到返回体去改动 HttpServletResponse。
 */
@Service
public class Guard {

    private final IdempotencyStore idem;
    private final RateLimitStore rateLimit;

    public Guard(IdempotencyStore idem, RateLimitStore rateLimit) {
        this.idem = idem;
        this.rateLimit = rateLimit;
    }

    /**
     * 幂等：同一 requestId 重复提交直接返回首次结果。
     * 只对携带 requestId 的请求生效；未携带则退化为普通调用（与原实现一致）。
     */
    public ApiResponse idempotent(Object requestId, Supplier<ApiResponse> handler) {
        long userId = CurrentUser.userId();
        String rid = requestId == null ? null : String.valueOf(requestId).trim();
        if (rid != null && rid.isEmpty()) {
            rid = null;
        }

        if (rid != null) {
            Object cached = idem.hit(userId, rid);
            if (cached instanceof ApiResponse resp) {
                return resp;
            }
        }

        ApiResponse resp = handler.get();
        if (rid != null) {
            idem.save(userId, rid, resp);
        }
        return resp;
    }

    /**
     * 防脚本刷课限速：窗口内超过软阈值返回 9001，超过硬阈值要求完成安全验证。
     * 注意与原实现一致，每次调用都会计入窗口，重复提交（幂等命中）同样计数。
     */
    public void rateLimited() {
        RateLimitStore.State state = rateLimit.check(CurrentUser.userId());
        if (state.needCaptcha()) {
            throw new BizException(ErrorCode.RATE_LIMITED,
                    "操作过于频繁，请完成安全验证后重试",
                    payload("needCaptcha", true, "count", state.count()));
        }
        if (state.limited()) {
            throw new BizException(ErrorCode.RATE_LIMITED,
                    "操作过于频繁，请 " + state.retryAfter() + " 秒后再试",
                    payload("retryAfter", state.retryAfter(), "count", state.count()));
        }
    }

    private static Map<String, Object> payload(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }
}
