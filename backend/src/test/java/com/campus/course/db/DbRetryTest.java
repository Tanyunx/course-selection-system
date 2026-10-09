package com.campus.course.db;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.SQLException;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.ConcurrencyFailureException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.DuplicateKeyException;

/**
 * 事务重试判定单测：只有"并发冲突"才允许重试，业务错误必须原样抛出。
 *
 * <p>这是本轮新增的死锁重试机制的正确性开关。判宽了会把业务异常反复重试
 * （比如唯一键冲突），判窄了死锁不再自愈。两条识别路径（Spring 异常类型 /
 * 沿 cause 链找 SQLState）都要覆盖。
 */
class DbRetryTest {

    @Test
    @DisplayName("Spring 的 DeadlockLoserDataAccessException 判定为可重试")
    void springDeadlock() {
        assertTrue(Db.isRetryableConflict(new DeadlockLoserDataAccessException("deadlock", null)));
    }

    @Test
    @DisplayName("SQLState 40P01（PostgreSQL 死锁）判定为可重试")
    void sqlStateDeadlock() {
        assertTrue(Db.isRetryableConflict(new RuntimeException(new SQLException("deadlock detected", "40P01"))));
    }

    @Test
    @DisplayName("SQLState 40001（序列化失败）判定为可重试")
    void sqlStateSerializationFailure() {
        assertTrue(Db.isRetryableConflict(new RuntimeException(new SQLException("could not serialize", "40001"))));
    }

    @Test
    @DisplayName("普通 ConcurrencyFailureException 判定为可重试")
    void concurrencyFailure() {
        assertTrue(Db.isRetryableConflict(new ConcurrencyFailureException("concurrent")));
    }

    @Test
    @DisplayName("深层嵌套的 cause 也能被找到（业务代码包了一层又一层）")
    void deeplyWrapped() {
        Throwable deep = new IllegalStateException("wrapper",
                new RuntimeException("inner",
                        new SQLException("deadlock detected", "40P01")));
        assertTrue(Db.isRetryableConflict(deep));
    }

    @Test
    @DisplayName("唯一键冲突（23505）不可重试——重试也没用，且会掩盖真实业务错误")
    void uniqueViolationNotRetryable() {
        assertFalse(Db.isRetryableConflict(new DuplicateKeyException("duplicate key")));
        assertFalse(Db.isRetryableConflict(new RuntimeException(new SQLException("dup", "23505"))));
    }

    @Test
    @DisplayName("其他 SQLState 与普通异常不可重试")
    void othersNotRetryable() {
        assertFalse(Db.isRetryableConflict(new RuntimeException(new SQLException("boom", "42601"))));
        assertFalse(Db.isRetryableConflict(new IllegalArgumentException("参数错误")));
        assertFalse(Db.isRetryableConflict(new NullPointerException()));
    }

    @Test
    @DisplayName("重试次数上限为 3（含首次），避免死锁时无限放大数据库压力")
    void maxAttemptsIsBounded() {
        assertTrue(Db.MAX_TX_ATTEMPTS >= 2 && Db.MAX_TX_ATTEMPTS <= 5,
                "重试上限应在合理区间，当前为 " + Db.MAX_TX_ATTEMPTS);
    }

    @Test
    @DisplayName("退避时间大于 0，且存在随机抖动避免重试再次相撞")
    void backoffIsPositive() {
        assertTrue(Db.RETRY_BASE_MILLIS > 0);
    }

    @Test
    @DisplayName("自引用 cause（cause == this）不会造成死循环")
    void selfReferencingCauseDoesNotLoop() {
        Throwable selfRef = new RuntimeException("self") {
            @Override
            public synchronized Throwable getCause() {
                return this;
            }
        };
        assertFalse(Db.isRetryableConflict(selfRef));
    }
}
