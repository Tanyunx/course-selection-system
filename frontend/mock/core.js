'use strict';

/**
 * 静态版（免安装单文件网页）· 基础设施层
 *
 * 设计意图：
 *   数据库版把业务数据放在 MySQL、把逻辑放在 Node/Express；
 *   单文件网页版把两者都搬进浏览器内存，用同一套业务规则复刻后端行为。
 *   因此这里的函数命名与职责，刻意与数据库版的 server/ 目录保持一一对应，
 *   便于两份实现互相对照与回归。
 *
 * 本文件包含：时间工具、内存表存储、自增主键、审计日志、通知、指标采集。
 */

/* ================================================================== */
/* 一、时间工具                                                        */
/* ================================================================== */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 统一的时间格式：'YYYY-MM-DD HH:mm:ss'（与后端写库格式一致，便于字符串直接比较） */
function fmtDateTime(d) {
  const x = d instanceof Date ? d : new Date(d);
  return (
    `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())} ` +
    `${pad2(x.getHours())}:${pad2(x.getMinutes())}:${pad2(x.getSeconds())}`
  );
}

function fmtDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

/** 当前时刻字符串 */
function now() {
  return fmtDateTime(new Date());
}

/**
 * 解析数据库时间串为 Date。
 * 支持 'YYYY-MM-DD' 与 'YYYY-MM-DD HH:mm:ss' 两种形态；
 * 手工解析而不依赖 Date.parse，避免不同浏览器的时区/格式差异。
 */
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  const s = String(v).trim().replace('T', ' ');
  const [dPart, tPart] = s.split(' ');
  const d = (dPart || '').split('-').map(Number);
  const t = (tPart || '00:00:00').split(':').map(Number);
  if (!d[0]) return null;
  return new Date(d[0], (d[1] || 1) - 1, d[2] || 1, t[0] || 0, t[1] || 0, t[2] || 0);
}

/** 在指定时间上增加天数，返回新的时间串 */
function addDays(v, days) {
  const d = toDate(v);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  return d;
}

/* ================================================================== */
/* 二、内存表存储                                                      */
/* ================================================================== */

/** 全部表数据（结构完全对齐数据库版的 18 张 t_ 表） */
let tables = {};
/** 各表自增主键游标 */
let seq = {};

/** 数据版本号：每次重置自增，用于让前端缓存失效 */
let dataVersion = 1;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 用初始种子数据重建全部表，并重算自增游标 */
function resetData() {
  tables = {};
  seq = {};
  Object.keys(DATA).forEach((name) => {
    const rows = clone(DATA[name]);
    tables[name] = rows;
    seq[name] = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  });
  dataVersion += 1;
}

function tbl(name) {
  if (!tables[name]) tables[name] = [];
  return tables[name];
}

function nextId(name) {
  if (!seq[name]) seq[name] = 1;
  return seq[name]++;
}

/** 插入一行；未显式给 id 时自动分配 */
function insert(name, row) {
  const r = row;
  if (r.id === undefined || r.id === null) r.id = nextId(name);
  r.created_at = r.created_at || now();
  r.updated_at = r.updated_at || now();
  tbl(name).push(r);
  return r;
}

/** 按 id 查找 */
function findById(name, id) {
  return tbl(name).find((r) => Number(r.id) === Number(id)) || null;
}

/** 浅层条件查询：{ field: value } */
function findWhere(name, cond) {
  return tbl(name).filter((r) =>
    Object.keys(cond).every((k) => {
      const want = cond[k];
      if (Array.isArray(want)) return want.map(Number).includes(Number(r[k]));
      return String(r[k]) === String(want);
    })
  );
}

function removeWhere(name, cond) {
  const keep = tbl(name).filter(
    (r) => !Object.keys(cond).every((k) => String(r[k]) === String(cond[k]))
  );
  const removed = tbl(name).length - keep.length;
  tables[name] = keep;
  return removed;
}

/** 按自定义谓词删除，用于「字段 A 或字段 B 命中」这类复合删除条件 */
function removeBy(name, predicate) {
  const keep = tbl(name).filter((r) => !predicate(r));
  const removed = tbl(name).length - keep.length;
  tables[name] = keep;
  return removed;
}

/* ================================================================== */
/* 三、错误码（与后端 server/utils/errors.js 完全一致）                 */
/* ================================================================== */

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
    this.extra = extra || null;
  }
}

/* ================================================================== */
/* 四、配置（对齐后端 config/config.js 的业务参数）                     */
/* ================================================================== */

const CONFIG = {
  auth: {
    idleTimeoutMinutes: 30,
    captchaAfterFailures: 5,
  },
  rateLimit: {
    windowSeconds: 60,
    softLimit: 10,
    hardLimit: 20,
  },
  idempotencyTtlMinutes: 5,
  business: {
    waitlistConfirmHours: 24,
    dropDeadlineDaysAfterBatch: 7,
  },
};

/* ================================================================== */
/* 五、会话、验证码、幂等、限速                                        */
/* ================================================================== */

const sessions = new Map(); // jti -> { userId, username, realName, role, lastActive }
const loginFailures = new Map(); // username -> count
const captchas = new Map(); // id -> { answer, expire }
const idempotencyCache = new Map(); // `${userId}:${requestId}` -> { body, at }
const rateBuckets = new Map(); // userId -> { hits: [ts] }

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createSession(payload) {
  const jti = payload.jti;
  sessions.set(jti, {
    userId: payload.userId,
    username: payload.username,
    realName: payload.realName,
    role: payload.role,
    lastActive: Date.now(),
  });
  return jti;
}

function isSessionIdle(jti) {
  const s = sessions.get(jti);
  if (!s) return true;
  return Date.now() - s.lastActive > CONFIG.auth.idleTimeoutMinutes * 60 * 1000;
}

function touchSession(jti) {
  const s = sessions.get(jti);
  if (s) s.lastActive = Date.now();
  return s;
}

/* ================================================================== */
/* 六、审计日志与通知                                                  */
/* ================================================================== */

const NOTICE_TYPE = {
  ENROLL_RESULT: 1,
  WAITLIST_PROMOTED: 2,
  WAITLIST_FAILED: 3,
  DROP_RESULT: 4,
  ANNOUNCEMENT: 5,
};

const NOTICE_TYPE_TEXT = { 1: '选课结果', 2: '候补递补', 3: '递补失败', 4: '退课', 5: '公告' };

function sendNotice(userId, type, title, content, relatedId) {
  insert('t_notice', {
    user_id: Number(userId),
    type: Number(type),
    title: String(title).slice(0, 100),
    content: String(content).slice(0, 500),
    related_id: relatedId === undefined ? null : relatedId,
    is_read: 0,
  });
}

function logAudit(payload, { action, targetType = null, targetId = null, result = 1, detail = null }) {
  const user = payload && payload.user ? payload.user : null;
  insert('t_audit_log', {
    user_id: user ? user.userId : null,
    username: user ? user.username : null,
    action,
    target_type: targetType,
    target_id: targetId,
    ip: (payload && payload.ip) || '127.0.0.1',
    result,
    detail: detail ? String(detail).slice(0, 500) : null,
  });
}

/* ================================================================== */
/* 七、运行指标（对齐后端 store/metrics.js 的口径）                     */
/* ================================================================== */

const metricsState = {
  startAt: Date.now(),
  total: 0,
  success: 0,
  fail: 0,
  durations: [],
  byPath: new Map(),
  errorsByCode: new Map(),
};

function recordMetric(path, code, ms) {
  metricsState.total += 1;
  if (code === 0) metricsState.success += 1;
  else {
    metricsState.fail += 1;
    metricsState.errorsByCode.set(code, (metricsState.errorsByCode.get(code) || 0) + 1);
  }
  metricsState.durations.push(ms);
  if (metricsState.durations.length > 500) metricsState.durations.shift();

  const key = path;
  if (!metricsState.byPath.has(key)) {
    metricsState.byPath.set(key, { total: 0, fail: 0, totalMs: 0 });
  }
  const v = metricsState.byPath.get(key);
  v.total += 1;
  v.totalMs += ms;
  if (code !== 0) v.fail += 1;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function metricsSnapshot(queueLength) {
  const durations = metricsState.durations;
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const rate = metricsState.total ? metricsState.success / metricsState.total : 1;

  const topPaths = [...metricsState.byPath.entries()]
    .map(([path, v]) => ({
      path,
      total: v.total,
      fail: v.fail,
      avgMs: v.total ? Math.round(v.totalMs / v.total) : 0,
      errorRate: v.total ? Math.round((v.fail / v.total) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  return {
    uptimeSeconds: Math.round((Date.now() - metricsState.startAt) / 1000),
    totalRequests: metricsState.total,
    successRequests: metricsState.success,
    failedRequests: metricsState.fail,
    successRate: Math.round(rate * 10000) / 100,
    writeP95Ms: percentile(durations, 95),
    writeAvgMs: Math.round(avg),
    queueLength: queueLength || 0,
    cacheDiff: 0,
    errorsByCode: [...metricsState.errorsByCode.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    topPaths,
  };
}

/* ================================================================== */
/* 节次时间表（与学校《课时表》一致，每节 40 分钟）                       */
/* 对应 server/utils/period.js、public/js/ui.js，三处需保持一致        */
/* ================================================================== */

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

const PERIOD_COUNT = 13;

/** 节次区间 → 起止时间文本，如 (1, 2) → '08:00~09:25' */
function periodRangeText(start, end) {
  const a = PERIOD_TIME[start];
  const b = PERIOD_TIME[end] || a;
  if (!a) return '';
  return `${a.slice(0, 5)}~${b.slice(6)}`;
}

/** 校验排课时段（星期、节次区间、单双周）；与 server/utils/period.js 口径一致 */
function assertValidSchedules(list) {
  if (!Array.isArray(list)) return;
  list.forEach((s) => {
    const wd = Number(s.weekday);
    const sp = Number(s.startPeriod !== undefined ? s.startPeriod : s.start_period);
    const ep = Number(s.endPeriod !== undefined ? s.endPeriod : s.end_period);
    const parity = Number(s.parity || 0);
    if (!(wd >= 1 && wd <= 7)) throw new AppError(CODES.BAD_REQUEST, '星期取值需在 1 至 7 之间');
    if (!(sp >= 1 && ep <= PERIOD_COUNT && sp <= ep)) {
      throw new AppError(CODES.BAD_REQUEST, `节次取值不合法（1 至 ${PERIOD_COUNT}，且起始不大于结束）`);
    }
    if (![0, 1, 2].includes(parity)) throw new AppError(CODES.BAD_REQUEST, '单双周取值不合法');
  });
}

/* ================================================================== */

resetData();

module.exports = {
  pad2,
  fmtDateTime,
  fmtDay,
  now,
  toDate,
  addDays,
  resetData,
  tbl,
  nextId,
  insert,
  findById,
  findWhere,
  removeWhere,
  removeBy,
  tablesRef: () => tables,
  CODES,
  MESSAGES,
  AppError,
  CONFIG,
  sessions,
  loginFailures,
  captchas,
  idempotencyCache,
  rateBuckets,
  randomId,
  randomInt,
  createSession,
  isSessionIdle,
  touchSession,
  NOTICE_TYPE,
  NOTICE_TYPE_TEXT,
  sendNotice,
  logAudit,
  recordMetric,
  metricsSnapshot,
  PERIOD_TIME,
  PERIOD_COUNT,
  periodRangeText,
  assertValidSchedules,
};
