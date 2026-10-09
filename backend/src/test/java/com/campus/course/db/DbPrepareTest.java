package com.campus.course.db;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * Db 参数预处理与取值助手单测。
 *
 * <p>这里覆盖的是历史事故高发区：
 * 1) {@code IN (?)} 集合展开——曾漏展开导致 SQL 报错；
 * 2) 占位符与参数数量不匹配——旧实现默默补 null 掩盖错误，排查成本极高，
 *    现在要求立刻抛异常；
 * 3) 数据库返回值可能是 Integer/Long/BigDecimal/String，取值助手必须都吃得下。
 *
 * <p>{@code prepare} 是包级可见的静态方法，测试与其同包，直接调用。
 */
class DbPrepareTest {

    /** 从 record 里取 sql 字符串（record 是 private，用反射避免改可见性）。 */
    private static String sqlOf(Object prepared) throws Exception {
        return (String) prepared.getClass().getDeclaredMethod("sql").invoke(prepared);
    }

    private static Object[] argsOf(Object prepared) throws Exception {
        return (Object[]) prepared.getClass().getDeclaredMethod("args").invoke(prepared);
    }

    private static Object prepared(String sql, Object[] args) {
        return Db.prepare(sql, args);
    }

    @Nested
    @DisplayName("prepare：普通占位符")
    class Plain {

        @Test
        @DisplayName("无参数时原样返回")
        void noArgs() throws Exception {
            Object p = prepared("SELECT 1", null);
            assertEquals("SELECT 1", sqlOf(p));
            assertEquals(0, argsOf(p).length);

            Object p2 = prepared("SELECT 1", new Object[0]);
            assertEquals("SELECT 1", sqlOf(p2));
            assertEquals(0, argsOf(p2).length);
        }

        @Test
        @DisplayName("普通标量参数保持 ? 不变")
        void scalars() throws Exception {
            Object p = prepared("SELECT * FROM t WHERE a = ? AND b = ?", new Object[]{1, "x"});
            assertEquals("SELECT * FROM t WHERE a = ? AND b = ?", sqlOf(p));
            assertArrayEquals(new Object[]{1, "x"}, argsOf(p));
        }
    }

    @Nested
    @DisplayName("prepare：IN (?) 集合展开")
    class InExpansion {

        @Test
        @DisplayName("List 展开成 N 个占位符，参数被拉平")
        void listExpansion() throws Exception {
            Object p = prepared("SELECT * FROM t WHERE id IN (?)", new Object[]{List.of(1, 2, 3)});
            assertEquals("SELECT * FROM t WHERE id IN (?,?,?)", sqlOf(p));
            assertArrayEquals(new Object[]{1, 2, 3}, argsOf(p));
        }

        @Test
        @DisplayName("数组同样可以展开")
        void arrayExpansion() throws Exception {
            Object p = prepared("SELECT * FROM t WHERE id IN (?)", new Object[]{new Object[]{"a", "b"}});
            assertEquals("SELECT * FROM t WHERE id IN (?,?)", sqlOf(p));
            assertArrayEquals(new Object[]{"a", "b"}, argsOf(p));
        }

        @Test
        @DisplayName("集合为空时展开为 IN (NULL)，语义上「永不匹配」而不是语法错误")
        void emptyCollection() throws Exception {
            Object p = prepared("SELECT * FROM t WHERE id IN (?)", new Object[]{Collections.emptyList()});
            assertEquals("SELECT * FROM t WHERE id IN (NULL)", sqlOf(p));
            assertEquals(0, argsOf(p).length);
        }

        @Test
        @DisplayName("多个占位符混合：前面的标量 + 后面的集合，顺序不能乱")
        void mixed() throws Exception {
            Object p = prepared("SELECT * FROM t WHERE term = ? AND id IN (?) AND status = ?",
                    new Object[]{"2025-2026-1", List.of(7, 8), 1});
            assertEquals("SELECT * FROM t WHERE term = ? AND id IN (?,?) AND status = ?", sqlOf(p));
            assertArrayEquals(new Object[]{"2025-2026-1", 7, 8, 1}, argsOf(p));
        }

        @Test
        @DisplayName("两个集合连续出现也能各自展开")
        void twoCollections() throws Exception {
            Object p = prepared("SELECT * FROM t WHERE a IN (?) AND b IN (?)",
                    new Object[]{List.of(1, 2), Arrays.asList(3, 4, 5)});
            assertEquals("SELECT * FROM t WHERE a IN (?,?) AND b IN (?,?,?)", sqlOf(p));
            assertArrayEquals(new Object[]{1, 2, 3, 4, 5}, argsOf(p));
        }

        @Test
        @DisplayName("集合参数用在非 IN 位置时报错，而不是生成非法 SQL")
        void collectionOutsideIn() {
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                    () -> prepared("SELECT * FROM t WHERE id = ?", new Object[]{List.of(1, 2)}));
            assertTrue(ex.getMessage().contains("IN (?)"), "异常信息应提示集合只能用于 IN (?)");
        }
    }

    @Nested
    @DisplayName("prepare：参数校验（历史事故：静默补 null）")
    class Validation {

        @Test
        @DisplayName("占位符多于参数时立刻抛异常，并报出是第几个")
        void tooFewArgs() {
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                    () -> prepared("SELECT * FROM t WHERE a = ? AND b = ?", new Object[]{1}));
            assertTrue(ex.getMessage().contains("第 2 个占位符"), "应指出缺失的是第 2 个占位符");
            assertTrue(ex.getMessage().contains("SQL="), "应把 SQL 一并打印便于定位");
        }

        @Test
        @DisplayName("参数多于占位符时同样抛异常（多余的参数说明调用方写错了）")
        void tooManyArgs() {
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                    () -> prepared("SELECT * FROM t WHERE a = ?", new Object[]{1, 2}));
            assertTrue(ex.getMessage().contains("参数数量"), "异常信息应提到参数数量不一致");
        }

        @Test
        @DisplayName("注释里的问号也算占位符——这是刻意行为，提醒写 SQL 时别在注释里写问号")
        void questionMarkInCommentIsCounted() {
            // 说明：prepare 不做 SQL 词法分析，'-- 这里写个 ?' 也会被当成占位符。
            // 这个测试把"已知行为"固定下来，避免以后有人误以为它会跳过注释。
            assertThrows(IllegalArgumentException.class,
                    () -> prepared("SELECT * FROM t -- 备注 ?\n WHERE a = ?", new Object[]{1}));
        }
    }

    @Nested
    @DisplayName("取值助手：不同类型都要吃得下")
    class ValueHelpers {

        @Test
        @DisplayName("toLong：null→0，Number 直取，字符串解析")
        void toLong() {
            assertEquals(0L, Db.toLong(null));
            assertEquals(5L, Db.toLong(5));
            assertEquals(5L, Db.toLong(5L));
            assertEquals(5L, Db.toLong((short) 5));
            assertEquals(7L, Db.toLong("7"));
            assertEquals(0L, Db.toLong(BigDecimal.ZERO));
        }

        @Test
        @DisplayName("num / numOrNull：null 安全")
        void numAndNumOrNull() {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("a", 3);
            assertEquals(3L, Db.num(row, "a"));
            assertEquals(0L, Db.num(row, "missing"));
            assertEquals(0L, Db.num(null, "a"));

            assertEquals(3L, Db.numOrNull(row, "a"));
            assertEquals(null, Db.numOrNull(row, "missing"));
            assertEquals(null, Db.numOrNull(null, "a"));
        }

        @Test
        @DisplayName("decimal：null→BigDecimal.ZERO，字符串可解析")
        void decimal() {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("x", "2.5");
            assertEquals(new BigDecimal("2.5"), Db.decimal(row, "x"));
            assertEquals(BigDecimal.ZERO, Db.decimal(row, "none"));
            assertEquals(BigDecimal.ZERO, Db.decimal(null, "x"));

            row.put("y", new BigDecimal("1.25"));
            assertEquals(new BigDecimal("1.25"), Db.decimal(row, "y"));
        }

        @Test
        @DisplayName("str：null→null，其他转字符串")
        void str() {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("s", "abc");
            row.put("n", 12);
            assertEquals("abc", Db.str(row, "s"));
            assertEquals("12", Db.str(row, "n"));
            assertEquals(null, Db.str(row, "none"));
            assertEquals(null, Db.str(null, "s"));
        }

        @Test
        @DisplayName("flag：0/1 语义转 boolean，null 视为 false")
        void flag() {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("on", 1);
            row.put("off", 0);
            assertTrue(Db.flag(row, "on"));
            assertEquals(false, Db.flag(row, "off"));
            assertEquals(false, Db.flag(row, "none"));
            assertEquals(false, Db.flag(null, "on"));
        }
    }
}
