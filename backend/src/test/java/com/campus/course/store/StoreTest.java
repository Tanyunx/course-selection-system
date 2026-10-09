package com.campus.course.store;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.campus.course.config.AppProperties;

/**
 * 限速与幂等存储单测（对应设计文档 4.5 防脚本刷课、2.4 幂等）。
 *
 * <p>这两个类都是纯内存实现，不依赖数据库，可以直接 new 出来测。
 * 限速窗口用的是 System.currentTimeMillis，测试只验证阈值行为不做时间穿越，
 * 因此断言都放在"计数与阈值关系"上，避免引入不稳定的 sleep。
 */
class StoreTest {

    private static AppProperties props() {
        AppProperties p = new AppProperties();
        // 默认：window=60s soft=10 hard=20
        return p;
    }

    @Test
    @DisplayName("限速：软阈值以内（≤10 次）不拦截")
    void underSoftLimit() {
        RateLimitStore store = new RateLimitStore(props());
        for (int i = 1; i <= 10; i++) {
            RateLimitStore.State s = store.check(1L);
            assertEquals(i, s.count(), "第 " + i + " 次的计数");
            assertFalse(s.limited(), "第 " + i + " 次不应被限速");
            assertFalse(s.needCaptcha(), "第 " + i + " 次不应要求安全验证");
        }
    }

    @Test
    @DisplayName("限速：第 11 次触发软限速（9001）但暂不要求验证码")
    void softLimitTrips() {
        RateLimitStore store = new RateLimitStore(props());
        for (int i = 1; i <= 10; i++) {
            store.check(1L);
        }
        RateLimitStore.State s = store.check(1L);
        assertEquals(11, s.count());
        assertTrue(s.limited(), "超过软阈值应被限速");
        assertFalse(s.needCaptcha(), "未超硬阈值不应要求验证码");
        assertTrue(s.retryAfter() > 0, "被限速时应给出 retryAfter 秒数");
    }

    @Test
    @DisplayName("限速：第 21 次同时要求安全验证")
    void hardLimitTrips() {
        RateLimitStore store = new RateLimitStore(props());
        RateLimitStore.State s = null;
        for (int i = 1; i <= 21; i++) {
            s = store.check(1L);
        }
        assertEquals(21, s.count());
        assertTrue(s.limited());
        assertTrue(s.needCaptcha(), "超过硬阈值应要求安全验证");
    }

    @Test
    @DisplayName("限速：窗口内通过安全验证后免除限速")
    void captchaClearsLimit() {
        RateLimitStore store = new RateLimitStore(props());
        for (int i = 1; i <= 15; i++) {
            store.check(1L);
        }
        assertTrue(store.check(1L).limited(), "未验证时应被限速");

        store.markCaptchaPassed(1L);
        RateLimitStore.State s = store.check(1L);
        assertFalse(s.limited(), "验证通过后窗口内不再限速");
        assertFalse(s.needCaptcha(), "验证通过后不再要求验证");
    }

    @Test
    @DisplayName("限速：不同用户互不影响")
    void perUserIsolation() {
        RateLimitStore store = new RateLimitStore(props());
        for (int i = 1; i <= 15; i++) {
            store.check(1L);
        }
        assertTrue(store.check(1L).limited(), "用户 1 已被限速");
        RateLimitStore.State s = store.check(2L);
        assertFalse(s.limited(), "用户 2 不应受影响");
        assertEquals(1, s.count(), "用户 2 是第一次请求，计数应为 1");
    }

    @Test
    @DisplayName("限速：reset 清空某用户的状态")
    void resetClears() {
        RateLimitStore store = new RateLimitStore(props());
        for (int i = 1; i <= 15; i++) {
            store.check(1L);
        }
        assertTrue(store.check(1L).limited());
        store.reset(1L);
        RateLimitStore.State s = store.check(1L);
        assertEquals(1, s.count(), "reset 后计数重新从 1 开始");
        assertFalse(s.limited());
    }

    @Test
    @DisplayName("限速：sweep 不会误删仍在窗口内的记录")
    void sweepKeepsFreshEntries() {
        RateLimitStore store = new RateLimitStore(props());
        store.check(1L);
        store.check(2L);
        store.sweep();
        // 刚写入的记录仍在窗口内，计数不应被清零
        assertTrue(store.check(1L).count() >= 2);
        assertTrue(store.check(2L).count() >= 2);
    }

    @Test
    @DisplayName("幂等：首次未命中返回 null，保存后可命中同一结果")
    void idempotencyHitAndSave() {
        IdempotencyStore store = new IdempotencyStore(props());
        assertEquals(null, store.hit(1L, "req-1"), "首次未命中应为 null");

        store.save(1L, "req-1", "OK-1");
        assertEquals("OK-1", store.hit(1L, "req-1"), "保存后应命中");
    }

    @Test
    @DisplayName("幂等：requestId 为空/null 时不缓存也不命中")
    void idempotencyEmptyRequestId() {
        IdempotencyStore store = new IdempotencyStore(props());
        assertEquals(null, store.hit(1L, null));
        assertEquals(null, store.hit(1L, ""));
        store.save(1L, null, "x");
        store.save(1L, "", "x");
        assertEquals(null, store.hit(1L, null), "空 requestId 不应被缓存");
    }

    @Test
    @DisplayName("幂等：不同用户使用相同 requestId 不串号")
    void idempotencyPerUser() {
        IdempotencyStore store = new IdempotencyStore(props());
        store.save(1L, "same", "user-1-result");
        assertEquals("user-1-result", store.hit(1L, "same"));
        assertEquals(null, store.hit(2L, "same"), "用户 2 不应命中用户 1 的结果");
    }

    @Test
    @DisplayName("幂等：业务错误结果也要能缓存（重复提交返回一致）")
    void idempotencyCachesFailureResult() {
        IdempotencyStore store = new IdempotencyStore(props());
        store.save(1L, "req-err", 2001);
        assertEquals(2001, store.hit(1L, "req-err"));
    }

    @Test
    @DisplayName("幂等：sweep 不该误删未过期条目")
    void idempotencySweepKeepsFresh() {
        IdempotencyStore store = new IdempotencyStore(props());
        store.save(1L, "req-1", "OK");
        store.sweep();
        assertEquals("OK", store.hit(1L, "req-1"), "未过期条目不能被 sweep 清掉");
    }
}
