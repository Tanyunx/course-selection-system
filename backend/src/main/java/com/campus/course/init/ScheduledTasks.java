package com.campus.course.init;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.campus.course.security.SessionStore;
import com.campus.course.service.WaitlistService;
import com.campus.course.store.IdempotencyStore;
import com.campus.course.store.RateLimitStore;

/**
 * 后台巡检任务（等价于原 Node 版 app.js 中的 setInterval 与各 store 内的定时清理）。
 *
 * <p>四件事：
 * <ol>
 *   <li>候补递补确认超时回收（4.6 第 5 条）——每分钟扫描一次。这是"名额不被人占着不放"
 *       的关键机制：递补成功后 24 小时内未确认，名额会被回收并顺延给下一位；</li>
 *   <li>过期会话清理，避免内存增长；</li>
 *   <li>幂等请求记录清理；</li>
 *   <li>限速窗口清理。</li>
 * </ol>
 */
@Component
public class ScheduledTasks {

    private static final Logger log = LoggerFactory.getLogger(ScheduledTasks.class);

    private final WaitlistService waitlist;
    private final SessionStore sessions;
    private final IdempotencyStore idempotency;
    private final RateLimitStore rateLimit;

    public ScheduledTasks(WaitlistService waitlist, SessionStore sessions,
                          IdempotencyStore idempotency, RateLimitStore rateLimit) {
        this.waitlist = waitlist;
        this.sessions = sessions;
        this.idempotency = idempotency;
        this.rateLimit = rateLimit;
    }

    /** 候补递补确认超时回收：每分钟 */
    @Scheduled(fixedDelay = 60_000L, initialDelay = 30_000L)
    public void sweepWaitlist() {
        try {
            int n = waitlist.sweepExpired();
            if (n > 0) {
                log.info("候补超时回收：处理 {} 条递补记录", n);
            }
        } catch (Exception e) {
            log.error("候补超时回收失败", e);
        }
    }

    /** 过期会话清理：每 5 分钟 */
    @Scheduled(fixedDelay = 300_000L, initialDelay = 60_000L)
    public void sweepSessions() {
        try {
            sessions.sweep();
        } catch (Exception e) {
            log.error("会话清理失败", e);
        }
    }

    /** 幂等记录清理：每 1 分钟 */
    @Scheduled(fixedDelay = 60_000L, initialDelay = 60_000L)
    public void sweepIdempotency() {
        try {
            idempotency.sweep();
        } catch (Exception e) {
            log.error("幂等缓存清理失败", e);
        }
    }

    /** 限速窗口清理：每 5 分钟 */
    @Scheduled(fixedDelay = 300_000L, initialDelay = 120_000L)
    public void sweepRateLimit() {
        try {
            rateLimit.sweep();
        } catch (Exception e) {
            log.error("限速窗口清理失败", e);
        }
    }
}
