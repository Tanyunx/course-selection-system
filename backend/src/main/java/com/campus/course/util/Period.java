package com.campus.course.util;

import java.util.List;
import java.util.Map;

import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;

/**
 * 节次时间表（与学校《课时表》一致，每节 40 分钟）。
 *
 * <p>上午 1~5 节、下午 6~10 节、晚上 11~13 节；大节划分：
 * 一(1-2) 二(3-5) 三(6-7) 四(8-10) 五(11-13)。
 *
 * <p>注意：前端对应常量在 frontend/js/ui.js，两处需保持一致。
 * 课程从 8 节扩到 13 节后，这里与前端、教师端排课校验三处口径统一。
 */
public final class Period {

    public static final int COUNT = 13;

    private static final Map<Integer, String> TIME = Map.ofEntries(
            Map.entry(1, "08:00-08:40"),
            Map.entry(2, "08:45-09:25"),
            Map.entry(3, "09:45-10:25"),
            Map.entry(4, "10:30-11:10"),
            Map.entry(5, "11:15-11:55"),
            Map.entry(6, "13:00-13:40"),
            Map.entry(7, "13:45-14:25"),
            Map.entry(8, "14:45-15:25"),
            Map.entry(9, "15:30-16:10"),
            Map.entry(10, "16:15-16:55"),
            Map.entry(11, "18:00-18:40"),
            Map.entry(12, "18:45-19:25"),
            Map.entry(13, "19:30-20:10"));

    private static final Map<Integer, String> BAND = Map.ofEntries(
            Map.entry(1, "上午"), Map.entry(2, "上午"), Map.entry(3, "上午"),
            Map.entry(4, "上午"), Map.entry(5, "上午"),
            Map.entry(6, "下午"), Map.entry(7, "下午"), Map.entry(8, "下午"),
            Map.entry(9, "下午"), Map.entry(10, "下午"),
            Map.entry(11, "晚上"), Map.entry(12, "晚上"), Map.entry(13, "晚上"));

    private Period() {
    }

    /** 节次区间 → 起止时间文本，如 (1,2) → {@code 08:00~09:25} */
    public static String rangeText(int start, int end) {
        String a = TIME.get(start);
        String b = TIME.getOrDefault(end, a);
        if (a == null) {
            return "";
        }
        return a.substring(0, 5) + "~" + b.substring(6);
    }

    public static String timeOf(int period) {
        return TIME.getOrDefault(period, "");
    }

    public static String bandOf(int period) {
        return BAND.getOrDefault(period, "");
    }

    /**
     * 校验排课时段数组（星期、节次区间、单双周），不合法直接抛业务异常。
     * 教师端与教务端共用同一套约束，避免两侧口径不一致。
     */
    public static void assertValidSchedules(List<?> schedules) {
        if (schedules == null) {
            return;
        }
        for (Object item : schedules) {
            if (!(item instanceof Map<?, ?> s)) {
                throw new BizException(ErrorCode.BAD_REQUEST, "排课时段格式不正确");
            }
            int weekday = intOf(s.get("weekday"), 0);
            int start = intOf(firstNonNull(s.get("startPeriod"), s.get("start_period")), 0);
            int end = intOf(firstNonNull(s.get("endPeriod"), s.get("end_period")), 0);
            int parity = intOf(s.get("parity"), 0);

            if (weekday < 1 || weekday > 7) {
                throw new BizException(ErrorCode.BAD_REQUEST, "星期取值需在 1 至 7 之间");
            }
            if (start < 1 || end > COUNT || start > end) {
                throw new BizException(ErrorCode.BAD_REQUEST,
                        "节次取值不合法（1 至 " + COUNT + "，且起始不大于结束）");
            }
            if (parity != 0 && parity != 1 && parity != 2) {
                throw new BizException(ErrorCode.BAD_REQUEST, "单双周取值不合法");
            }
        }
    }

    private static Object firstNonNull(Object a, Object b) {
        return a != null ? a : b;
    }

    private static int intOf(Object v, int fallback) {
        if (v == null) {
            return fallback;
        }
        if (v instanceof Number n) {
            return n.intValue();
        }
        try {
            return Integer.parseInt(String.valueOf(v).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
