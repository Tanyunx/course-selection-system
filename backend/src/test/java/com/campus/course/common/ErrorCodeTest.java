package com.campus.course.common;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * 错误码表单测：分段约定与文案完整性。
 *
 * <p>错误码是前后端契约（对应设计文档表 5），前端按码做分支处理。
 * 一旦改了某个常量值而没同步前端，就会出现"提示错乱"。
 * 这里把分段规则与"每个码都有非空文案"两条硬约束锁死。
 */
class ErrorCodeTest {

    @Test
    @DisplayName("分段约定：0 成功；1001~1003 认证；2001~2014 业务；9001~9003 系统")
    void segments() {
        assertEquals(0, ErrorCode.SUCCESS);

        assertTrue(ErrorCode.LOGIN_FAILED >= 1000 && ErrorCode.LOGIN_FAILED < 2000);
        assertTrue(ErrorCode.TOKEN_INVALID >= 1000 && ErrorCode.TOKEN_INVALID < 2000);
        assertTrue(ErrorCode.NO_PERMISSION >= 1000 && ErrorCode.NO_PERMISSION < 2000);

        assertTrue(ErrorCode.CAPACITY_FULL >= 2000 && ErrorCode.CAPACITY_FULL < 3000);
        assertTrue(ErrorCode.OFFERING_NOT_FOUND >= 2000 && ErrorCode.OFFERING_NOT_FOUND < 3000);

        assertTrue(ErrorCode.RATE_LIMITED >= 9000);
        assertTrue(ErrorCode.INTERNAL_ERROR >= 9000);
        assertTrue(ErrorCode.BAD_REQUEST >= 9000);
    }

    @Test
    @DisplayName("关键错误码取值不被误改（前端已按这些值写死分支）")
    void keyValues() {
        assertEquals(1001, ErrorCode.LOGIN_FAILED);
        assertEquals(1002, ErrorCode.TOKEN_INVALID);
        assertEquals(1003, ErrorCode.NO_PERMISSION);
        assertEquals(2001, ErrorCode.CAPACITY_FULL);
        assertEquals(2002, ErrorCode.TIME_CONFLICT);
        assertEquals(2003, ErrorCode.CREDIT_EXCEED);
        assertEquals(2006, ErrorCode.DUPLICATE_ENROLL);
        assertEquals(2011, ErrorCode.NOT_ENROLLED);
        assertEquals(9001, ErrorCode.RATE_LIMITED);
        assertEquals(9002, ErrorCode.INTERNAL_ERROR);
        assertEquals(9003, ErrorCode.BAD_REQUEST);
    }

    @Test
    @DisplayName("业务码必须连续覆盖 2001~2014，不能有空洞")
    void noGapInBusinessRange() {
        int[] codes = {
                ErrorCode.CAPACITY_FULL, ErrorCode.TIME_CONFLICT, ErrorCode.CREDIT_EXCEED,
                ErrorCode.PREREQ_MISSING, ErrorCode.BATCH_OUT_OF_RANGE, ErrorCode.DUPLICATE_ENROLL,
                ErrorCode.DUPLICATE_WAITLIST, ErrorCode.DROP_DEADLINE_PASSED, ErrorCode.TARGET_NOT_SELECTABLE,
                ErrorCode.WAITLIST_EXPIRED, ErrorCode.NOT_ENROLLED, ErrorCode.OFFERING_CLOSED,
                ErrorCode.NOT_IN_WAITLIST, ErrorCode.OFFERING_NOT_FOUND
        };
        assertEquals(14, codes.length);
        for (int i = 0; i < codes.length; i++) {
            assertEquals(2001 + i, codes[i], "第 " + (i + 1) + " 个业务码应为 " + (2001 + i));
        }
    }

    @Test
    @DisplayName("每个已定义的码都有非空中文文案")
    void everyCodeHasText() {
        int[] all = {
                ErrorCode.SUCCESS,
                ErrorCode.LOGIN_FAILED, ErrorCode.TOKEN_INVALID, ErrorCode.NO_PERMISSION,
                ErrorCode.CAPACITY_FULL, ErrorCode.TIME_CONFLICT, ErrorCode.CREDIT_EXCEED,
                ErrorCode.PREREQ_MISSING, ErrorCode.BATCH_OUT_OF_RANGE, ErrorCode.DUPLICATE_ENROLL,
                ErrorCode.DUPLICATE_WAITLIST, ErrorCode.DROP_DEADLINE_PASSED, ErrorCode.TARGET_NOT_SELECTABLE,
                ErrorCode.WAITLIST_EXPIRED, ErrorCode.NOT_ENROLLED, ErrorCode.OFFERING_CLOSED,
                ErrorCode.NOT_IN_WAITLIST, ErrorCode.OFFERING_NOT_FOUND,
                ErrorCode.RATE_LIMITED, ErrorCode.INTERNAL_ERROR, ErrorCode.BAD_REQUEST
        };
        for (int code : all) {
            String text = ErrorCode.text(code);
            assertNotNull(text, "错误码 " + code + " 的文案不能为 null");
            assertTrue(text.length() > 0, "错误码 " + code + " 的文案不能为空");
        }
    }

    @Test
    @DisplayName("未注册的错误码回退为「操作失败」，不返回 null")
    void unknownCodeFallback() {
        assertEquals("操作失败", ErrorCode.text(7777));
        assertEquals("操作失败", ErrorCode.text(-1));
    }

    @Test
    @DisplayName("成功码的文案是「操作成功」（前端按这个文案做提示）")
    void successText() {
        assertEquals("操作成功", ErrorCode.text(ErrorCode.SUCCESS));
    }
}
