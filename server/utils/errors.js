'use strict';

/**
 * 错误码统一定义（对应设计文档 2.5 表 5 错误码与提示文案）。
 * 前端据错误码映射提示文案，避免文案散落。
 */

const CODES = {
  OK: 0,

  AUTH_FAILED: 1001,
  UNAUTHORIZED: 1002,
  FORBIDDEN: 1003,

  COURSE_FULL: 2001,
  TIME_CONFLICT: 2002,
  CREDIT_EXCEED: 2003,
  PREREQ_NOT_MET: 2004,
  OUT_OF_BATCH: 2005,
  ALREADY_ENROLLED: 2006,
  ALREADY_WAITLISTED: 2007,
  DROP_CLOSED: 2008,
  SWITCH_TARGET_INVALID: 2009,
  WAITLIST_EXPIRED: 2010,

  // —— 实现中补充的扩展错误码（表 5 为常用错误码清单）——
  NOT_ENROLLED: 2011,
  OFFERING_CLOSED: 2012,
  NOT_WAITLISTED: 2013,
  OFFERING_NOT_FOUND: 2014,

  RATE_LIMITED: 9001,
  INTERNAL_ERROR: 9002,
  BAD_REQUEST: 9003,
};

const MESSAGES = {
  [CODES.OK]: '操作成功',
  [CODES.AUTH_FAILED]: '账号或密码错误，请重新输入',
  [CODES.UNAUTHORIZED]: '登录状态已失效，请重新登录',
  [CODES.FORBIDDEN]: '当前角色无此操作权限',
  [CODES.COURSE_FULL]: '该课程名额已满，可加入候补',
  [CODES.TIME_CONFLICT]: '与已选课程时间冲突',
  [CODES.CREDIT_EXCEED]: '选课后将超出本学期学分上限',
  [CODES.PREREQ_NOT_MET]: '需先修并通过指定先修课程',
  [CODES.OUT_OF_BATCH]: '当前不在你可选的选课批次时间内',
  [CODES.ALREADY_ENROLLED]: '你已选该课程，无需重复选课',
  [CODES.ALREADY_WAITLISTED]: '你已加入候补',
  [CODES.DROP_CLOSED]: '已超过退课截止时间，无法退课',
  [CODES.SWITCH_TARGET_INVALID]: '目标课程不可选，原课程未变动',
  [CODES.WAITLIST_EXPIRED]: '候补机会已过期，名额已顺延他人',
  [CODES.NOT_ENROLLED]: '你尚未选修该课程',
  [CODES.OFFERING_CLOSED]: '该开课已停开，无法操作',
  [CODES.NOT_WAITLISTED]: '你不在该课程的候补队列中',
  [CODES.OFFERING_NOT_FOUND]: '未找到对应的开课记录',
  [CODES.RATE_LIMITED]: '当前访问过于频繁，请稍后再试',
  [CODES.INTERNAL_ERROR]: '系统繁忙，请稍后重试',
  [CODES.BAD_REQUEST]: '请求参数有误，请检查后重试',
};

class AppError extends Error {
  constructor(code, message, extra) {
    super(message || MESSAGES[code] || '操作失败');
    this.code = code;
    this.name = 'AppError';
    // 附加信息：冲突课程、候补排位、缺失先修等，便于前端精准提示
    this.extra = extra || null;
  }
}

module.exports = {
  CODES,
  MESSAGES,
  AppError,
  messageOf: (code, fallback) => MESSAGES[code] || fallback || '操作失败',
};
