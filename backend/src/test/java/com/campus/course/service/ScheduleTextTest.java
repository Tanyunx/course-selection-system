package com.campus.course.service;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * 星期 / 单双周 文案映射单测。
 *
 * <p>这两张表被 CourseService、RuleService、EnrollmentService 三处共用，
 * 前端课表与冲突提示都依赖它。特别是越界取值必须回退成空串/「全周」，
 * 否则会抛 ArrayIndexOutOfBounds 把整个接口打成 9002。
 */
class ScheduleTextTest {

    @Test
    @DisplayName("weekdayText：1~7 依次映射周一到周日")
    void weekdayNormal() {
        assertEquals("周一", CourseService.weekdayText(1));
        assertEquals("周二", CourseService.weekdayText(2));
        assertEquals("周三", CourseService.weekdayText(3));
        assertEquals("周四", CourseService.weekdayText(4));
        assertEquals("周五", CourseService.weekdayText(5));
        assertEquals("周六", CourseService.weekdayText(6));
        assertEquals("周日", CourseService.weekdayText(7));
    }

    @Test
    @DisplayName("weekdayText：0 与 >7 的越界值返回空串，不抛异常")
    void weekdayOutOfRange() {
        assertEquals("", CourseService.weekdayText(0));
        assertEquals("", CourseService.weekdayText(8));
        assertEquals("", CourseService.weekdayText(-1));
        assertEquals("", CourseService.weekdayText(Integer.MAX_VALUE));
    }

    @Test
    @DisplayName("parityText：0 全周 / 1 单周 / 2 双周")
    void parityNormal() {
        assertEquals("全周", CourseService.parityText(0));
        assertEquals("单周", CourseService.parityText(1));
        assertEquals("双周", CourseService.parityText(2));
    }

    @Test
    @DisplayName("parityText：未知取值回退为「全周」")
    void parityUnknown() {
        assertEquals("全周", CourseService.parityText(3));
        assertEquals("全周", CourseService.parityText(-5));
    }
}
