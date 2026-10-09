package com.campus.course.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * RuleService 纯逻辑单测：热度分档、占位符生成、数值与时间格式化。
 *
 * <p>这些方法是选课规则的"最小可验证单元"，不依赖数据库，因此用普通 JUnit 测试即可，
 * 不需要启动 Spring 容器。它们此前只能靠整链路黑盒测试间接覆盖，边界值（90%、60%、容量 0）
 * 一旦写错很难被发现，所以单独锁死。
 */
class RuleServiceTest {

    @Nested
    @DisplayName("heatOf 热度分档：利用率 ≥90% 高 / ≥60% 中 / 其余低")
    class Heat {

        @Test
        @DisplayName("利用率恰好 90% 判为「高」（边界含等号）")
        void exactlyNinetyPercentIsHigh() {
            assertEquals("高", RuleService.heatOf(90, 100));
        }

        @Test
        @DisplayName("利用率 89% 判为「中」")
        void eightyNinePercentIsMedium() {
            assertEquals("中", RuleService.heatOf(89, 100));
        }

        @Test
        @DisplayName("利用率恰好 60% 判为「中」（边界含等号）")
        void exactlySixtyPercentIsMedium() {
            assertEquals("中", RuleService.heatOf(60, 100));
        }

        @Test
        @DisplayName("利用率 59% 判为「低」")
        void fiftyNinePercentIsLow() {
            assertEquals("低", RuleService.heatOf(59, 100));
        }

        @Test
        @DisplayName("名额全满（利用率 100%）判为「高」")
        void fullIsHigh() {
            assertEquals("高", RuleService.heatOf(100, 100));
        }

        @Test
        @DisplayName("无人选课判为「低」")
        void nobodyIsLow() {
            assertEquals("低", RuleService.heatOf(0, 100));
        }

        @Test
        @DisplayName("容量为 0 时不出现除零，直接判「低」")
        void zeroCapacityIsLowNotCrash() {
            assertEquals("低", RuleService.heatOf(0, 0));
            assertEquals("低", RuleService.heatOf(5, 0));
        }

        @Test
        @DisplayName("容量为负数（脏数据）同样判「低」")
        void negativeCapacityIsLow() {
            assertEquals("低", RuleService.heatOf(3, -1));
        }
    }

    @Nested
    @DisplayName("placeholders 生成 n 个 ? 占位符")
    class Placeholders {

        @Test
        @DisplayName("n=0 返回空串")
        void zero() {
            assertEquals("", RuleService.placeholders(0));
        }

        @Test
        @DisplayName("n=1 返回单个 ?")
        void one() {
            assertEquals("?", RuleService.placeholders(1));
        }

        @Test
        @DisplayName("n=4 返回 ?,?,?,? （多余逗号不得出现）")
        void four() {
            assertEquals("?,?,?,?", RuleService.placeholders(4));
        }
    }

    @Nested
    @DisplayName("plain 小数值转字符串：去掉多余的 .00")
    class Plain {

        @Test
        @DisplayName("null 返回 \"0\"")
        void nullValue() {
            assertEquals("0", RuleService.plain(null));
        }

        @Test
        @DisplayName("整数形态的 3.00 输出 \"3\"（不能带小数尾巴）")
        void trailingZerosOfInteger() {
            assertEquals("3", RuleService.plain(new BigDecimal("3.00")));
        }

        @Test
        @DisplayName("真正的 2.5 保持 \"2.5\"")
        void realDecimal() {
            assertEquals("2.5", RuleService.plain(new BigDecimal("2.500")));
        }

        @Test
        @DisplayName("0.50 输出 \"0.5\"")
        void halfCredit() {
            assertEquals("0.5", RuleService.plain(new BigDecimal("0.50")));
        }
    }

    @Nested
    @DisplayName("tsOf / fmt 时间转换")
    class Time {

        @Test
        @DisplayName("null 转 null，fmt 输出空串")
        void nullSafe() {
            assertEquals(null, RuleService.tsOf(null));
            assertEquals("", RuleService.fmt(null));
        }

        @Test
        @DisplayName("LocalDateTime 正确转为 Timestamp")
        void fromLocalDateTime() {
            Timestamp ts = RuleService.tsOf(LocalDateTime.of(2026, 10, 9, 14, 30, 5));
            assertEquals(Timestamp.valueOf("2026-10-09 14:30:05"), ts);
        }

        @Test
        @DisplayName("ISO 风格的字符串（含 T）也能解析")
        void fromIsoString() {
            Timestamp ts = RuleService.tsOf("2026-10-09T08:00:00");
            assertEquals(Timestamp.valueOf("2026-10-09 08:00:00"), ts);
        }

        @Test
        @DisplayName("Timestamp 原样返回")
        void fromTimestamp() {
            Timestamp src = Timestamp.valueOf("2026-01-02 03:04:05");
            assertEquals(src, RuleService.tsOf(src));
        }
    }

    @Nested
    @DisplayName("payload 构造补充数据")
    class Payload {

        @Test
        @DisplayName("键值成对写入，保持插入顺序")
        void pairs() {
            Map<String, Object> m = RuleService.payload("a", 1, "b", "x");
            assertEquals(2, m.size());
            assertEquals(1, m.get("a"));
            assertEquals("x", m.get("b"));
        }

        @Test
        @DisplayName("落单的键被忽略，不抛异常")
        void oddCountIgnored() {
            Map<String, Object> m = RuleService.payload("a", 1, "b");
            assertEquals(1, m.size());
            assertTrue(m.containsKey("a"));
        }

        @Test
        @DisplayName("空参数返回空 Map")
        void empty() {
            assertTrue(RuleService.payload().isEmpty());
        }
    }
}
