'use strict';

/**
 * 节次时间表（与学校《课时表》一致，每节 40 分钟）。
 *
 * 上午 1~5 节、下午 6~10 节、晚上 11~13 节；大节划分：
 * 一(1-2) 二(3-5) 三(6-7) 四(8-10) 五(11-13)。
 *
 * 注意：前端对应常量在 public/js/ui.js，两处需保持一致。
 */

const { CODES, AppError } = require('./errors');

const PERIOD_TIME = {
  1: '08:00-08:40',
  2: '08:45-09:25',
  3: '09:45-10:25',
  4: '10:30-11:10',
  5: '11:15-11:55',
  6: '13:00-13:40',
  7: '13:45-14:25',
  8: '14:45-15:25',
  9: '15:30-16:10',
  10: '16:15-16:55',
  11: '18:00-18:40',
  12: '18:45-19:25',
  13: '19:30-20:10',
};

const PERIOD_BAND = {
  1: '上午', 2: '上午', 3: '上午', 4: '上午', 5: '上午',
  6: '下午', 7: '下午', 8: '下午', 9: '下午', 10: '下午',
  11: '晚上', 12: '晚上', 13: '晚上',
};

const PERIOD_GROUP = {
  1: '一', 2: '一', 3: '二', 4: '二', 5: '二',
  6: '三', 7: '三', 8: '四', 9: '四', 10: '四',
  11: '五', 12: '五', 13: '五',
};

const PERIOD_COUNT = 13;

/** 节次区间 → 起止时间文本，如 (1, 2) → '08:00~09:25' */
function rangeText(start, end) {
  const a = PERIOD_TIME[start];
  const b = PERIOD_TIME[end] || a;
  if (!a) return '';
  return `${a.slice(0, 5)}~${b.slice(6)}`;
}

/**
 * 校验排课时段数组（星期、节次区间、单双周），不合法直接抛业务异常。
 * 教师端与教务端共用同一套约束，避免两侧口径不一致。
 */
function assertValidSchedules(list) {
  if (!Array.isArray(list)) return;
  list.forEach((s) => {
    const wd = Number(s.weekday);
    const sp = Number(s.startPeriod !== undefined ? s.startPeriod : s.start_period);
    const ep = Number(s.endPeriod !== undefined ? s.endPeriod : s.end_period);
    const parity = Number(s.parity || 0);
    if (!(wd >= 1 && wd <= 7)) throw new AppError(CODES.BAD_REQUEST, '星期取值需在 1 至 7 之间');
    if (!(sp >= 1 && ep <= PERIOD_COUNT && sp <= ep))
      throw new AppError(CODES.BAD_REQUEST, `节次取值不合法（1 至 ${PERIOD_COUNT}，且起始不大于结束）`);
    if (![0, 1, 2].includes(parity)) throw new AppError(CODES.BAD_REQUEST, '单双周取值不合法');
  });
}

module.exports = {
  PERIOD_TIME,
  PERIOD_BAND,
  PERIOD_GROUP,
  PERIOD_COUNT,
  rangeText,
  assertValidSchedules,
  bandOf: (p) => PERIOD_BAND[p] || '',
  groupOf: (p) => PERIOD_GROUP[p] || '',
};
