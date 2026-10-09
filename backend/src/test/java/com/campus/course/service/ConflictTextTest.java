package com.campus.course.service;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.campus.course.db.Db;

/**
 * EnrollmentService.conflictText 文案单测：把冲突时段映射成给学生看的提示语。
 *
 * <p>该方法会被拼接进 2002「与已选课程时间冲突」的错误消息中，格式一旦错乱
 * （比如漏了节次、星期映射错位）用户体验就很差，因此把格式固定下来。
 */
class ConflictTextTest {

    private static Map<String, Object> conflict(String courseName, int weekday, int start, int end, int parity) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("course_name", courseName);
        m.put("weekday", weekday);
        m.put("start_period", start);
        m.put("end_period", end);
        m.put("parity", parity);
        return m;
    }

    @Test
    @DisplayName("单条冲突：书名号 + 星期 + 节次区间 + 单双周")
    void single() {
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(conflict("数据结构", 1, 1, 2, 0));
        assertEquals("《数据结构》周一 1-2 节（全周）", EnrollmentService.conflictText(list));
    }

    @Test
    @DisplayName("多条冲突用中文分号「；」连接")
    void multiple() {
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(conflict("数据结构", 1, 1, 2, 0));
        list.add(conflict("操作系统", 3, 5, 6, 2));
        assertEquals("《数据结构》周一 1-2 节（全周）；《操作系统》周三 5-6 节（双周）",
                EnrollmentService.conflictText(list));
    }

    @Test
    @DisplayName("空列表返回空串（不生成多余的标点）")
    void empty() {
        assertEquals("", EnrollmentService.conflictText(new ArrayList<>()));
    }

    @Test
    @DisplayName("星期越界时星期部分为空，其余信息仍完整")
    void weekdayOutOfRange() {
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(conflict("体育", 8, 3, 4, 1));
        assertEquals("《体育》 3-4 节（单周）", EnrollmentService.conflictText(list));
    }

    @Test
    @DisplayName("周日的边界值 7 正常映射")
    void sunday() {
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(conflict("选修", 7, 9, 10, 0));
        assertEquals("《选修》周日 9-10 节（全周）", EnrollmentService.conflictText(list));
    }

    @Test
    @DisplayName("单双周未知取值回退为「全周」")
    void unknownParity() {
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(conflict("实验", 5, 1, 4, 9));
        assertEquals("《实验》周五 1-4 节（全周）", EnrollmentService.conflictText(list));
    }

    @Test
    @DisplayName("数值字段为字符串时也能正确取数（Db.num 的容错）")
    void numericAsString() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("course_name", "编译原理");
        m.put("weekday", "2");
        m.put("start_period", "3");
        m.put("end_period", "4");
        m.put("parity", "1");
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(m);
        assertEquals("《编译原理》周二 3-4 节（单周）", EnrollmentService.conflictText(list));
    }

    @Test
    @DisplayName("辅助确认 Db.num 对空 Map 返回 0（历史上这里最容易 NPE）")
    void dbNumNullSafe() {
        assertEquals(0L, Db.num(null, "weekday"));
        assertEquals(0L, Db.num(new LinkedHashMap<>(), "weekday"));
    }
}
