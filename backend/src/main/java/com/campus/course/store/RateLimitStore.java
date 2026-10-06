package com.campus.course.store;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import com.campus.course.config.AppProperties;

/**
 * 防脚本刷课限速（对应设计文档 4.5 与表 7，等价于原 Node 版的 store/rateLimit.js）。
 *
 * <p>同一账号在时间窗口内：超过软阈值拒绝并提示稍后再试（9001）；
 * 超过硬阈值要求先完成安全验证。仅作用于选课等写操作，读操作不受影响。
 */
@Component
public class RateLimitStore {

    /** 一次限速判定的结果 */
    public record State(boolean limited, boolean needCaptcha, int count, long retryAfter) {
    }

    private final Map<Long, Deque<Long>> buckets = new ConcurrentHashMap<>();
    private final Map<Long, Long> verified = new ConcurrentHashMap<>();
    private final int windowSeconds;
    private final int softLimit;
    private final int hardLimit;

    public RateLimitStore(AppProperties props) {
        AppProperties.RateLimit rl = props.getRateLimit();
        this.windowSeconds = rl.getWindowSeconds();
        this.softLimit = rl.getSoftLimit();
        this.hardLimit = rl.getHardLimit();
    }

    public State check(long userId) {
        long now = System.currentTimeMillis();
        long win = windowSeconds * 1000L;

        Deque<Long> list = buckets.computeIfAbsent(userId, k -> new ArrayDeque<>());
        synchronized (list) {
            while (!list.isEmpty() && now - list.peekFirst() > win) {
                list.pollFirst();
            }
            list.addLast(now);

            long lastVerified = verified.getOrDefault(userId, 0L);
            boolean captchaOk = now - lastVerified < win;

            int count = list.size();
            boolean needCaptcha = count > hardLimit && !captchaOk;
            boolean limited = count > softLimit && !captchaOk;

            long retryAfter = 0;
            if (limited && !list.isEmpty()) {
                retryAfter = (long) Math.ceil((win - (now - list.peekFirst())) / 1000.0);
            }
            return new State(limited, needCaptcha, count, retryAfter);
        }
    }

    /** 前端完成安全验证后调用，窗口内免除限速。 */
    public void markCaptchaPassed(long userId) {
        verified.put(userId, System.currentTimeMillis());
    }

    public void reset(long userId) {
        buckets.remove(userId);
        verified.remove(userId);
    }

    /** 定期清理窗口外的空桶，避免长期运行内存增长。 */
    public void sweep() {
        long now = System.currentTimeMillis();
        long win = windowSeconds * 1000L;
        buckets.entrySet().removeIf(e -> {
            Deque<Long> list = e.getValue();
            synchronized (list) {
                while (!list.isEmpty() && now - list.peekFirst() > win) {
                    list.pollFirst();
                }
                return list.isEmpty();
            }
        });
        verified.entrySet().removeIf(e -> now - e.getValue() > win);
    }
}
