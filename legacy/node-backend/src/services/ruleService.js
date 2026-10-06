'use strict';

/**
 * 选课规则引擎（见设计文档第 4 章）。
 * 全部规则在服务端强制校验，前端提示仅作辅助。
 */

const db = require('../db');
const config = require('../../config/config');
const { CODES, AppError } = require('../utils/errors');

/**
 * 统一的查询执行器。
 * 传入事务连接 conn 时必须走事务连接，否则会额外占用连接池连接：
 * 当事务已占满连接池且持有行锁时，再向连接池申请连接会造成互相等待（连接池耗尽死锁）。
 */
function runner(conn) {
  return conn
    ? (sql, p = []) => conn.query(sql, p).then(([r]) => r)
    : (sql, p = []) => db.query(sql, p);
}

/** 取当前学期；无 is_current 时取最新学期 */
async function getCurrentTerm(conn = null) {
  const q = runner(conn);
  const rows = await q(`SELECT * FROM t_term ORDER BY is_current DESC, start_date DESC LIMIT 1`);
  return rows.length ? rows[0] : null;
}

async function getTermById(termId) {
  return db.queryOne(`SELECT * FROM t_term WHERE id = ?`, [termId]);
}

/**
 * 批次准入（4.1 / 4.5 第一层）。
 * 一名学生可能命中多个批次，取「优先级最高（priority 最小）且时间窗口命中」的批次。
 * 返回 { batch, matches, inWindow }
 */
async function resolveBatch(termId, student, at = new Date(), conn = null) {
  const q = runner(conn);
  const rows = await q(
    `SELECT * FROM t_enroll_batch
      WHERE term_id = ? AND status = 1
      ORDER BY priority ASC, start_time ASC`,
    [termId]
  );

  const matched = rows.filter((b) => {
    const gradeOk =
      !b.target_grade || b.target_grade.split(',').map((s) => s.trim()).filter(Boolean).includes(student.grade);
    const collegeOk = !b.target_college || b.target_college.includes(student.college);
    return gradeOk && collegeOk;
  });

  const inWindow = matched.filter((b) => at >= new Date(b.start_time) && at <= new Date(b.end_time));
  return {
    batch: inWindow.length ? inWindow[0] : null,
    matches: matched,
    next: matched.find((b) => new Date(b.start_time) > at) || null,
  };
}

/** 批次校验：不在窗口内抛 2005 */
async function assertInBatch(termId, student, at = new Date(), conn = null) {
  const { batch, matches, next } = await resolveBatch(termId, student, at, conn);
  if (!batch) {
    const hint = next
      ? `你的选课批次将于 ${fmt(next.start_time)} 开放`
      : '当前不在任何可选批次时间内，请查看选课通知';
    throw new AppError(CODES.OUT_OF_BATCH, `当前不在你可选的选课批次时间内。${hint}`, {
      nextBatch: next ? { name: next.name, startTime: next.start_time } : null,
    });
  }
  return batch;
}

function fmt(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

/**
 * 时间冲突检测（4.3）。
 * 判定条件：weekday 相同，且节次区间相交，且单双周不互斥。
 * 一门课存在多个时段时，任一时段冲突即整体冲突。
 *
 * @param conn    可选事务连接
 * @param offeringId 目标开课
 * @param studentId  学生
 * @param termId     学期
 */
async function detectConflict(offeringId, studentId, termId, conn = null, excludeOfferingIds = []) {
  const run = runner(conn);

  const exclude = [offeringId, ...excludeOfferingIds].filter((x) => x !== null && x !== undefined);
  const placeholders = exclude.map(() => '?').join(',');

  const conflicts = await run(
    `SELECT DISTINCT
            c.name            AS course_name,
            c.course_code     AS course_code,
            s2.offering_id    AS offering_id,
            s1.weekday        AS weekday,
            s1.start_period   AS start_period,
            s1.end_period     AS end_period,
            s1.parity         AS parity,
            s2.start_period   AS other_start_period,
            s2.end_period     AS other_end_period,
            s2.parity         AS other_parity,
            s1.campus         AS campus,
            s2.campus         AS other_campus
       FROM t_course_schedule s1
       JOIN t_course_schedule s2
         ON s2.weekday = s1.weekday
        AND s1.start_period <= s2.end_period
        AND s2.start_period <= s1.end_period
        AND NOT ((s1.parity = 1 AND s2.parity = 2) OR (s1.parity = 2 AND s2.parity = 1))
       JOIN t_enrollment e
         ON e.offering_id = s2.offering_id AND e.student_id = ? AND e.status = 1
       JOIN t_course_offering o2 ON o2.id = s2.offering_id AND o2.term_id = ?
       JOIN t_course c ON c.id = o2.course_id
      WHERE s1.offering_id = ? AND s2.offering_id NOT IN (${placeholders})`,
    [studentId, termId, offeringId, ...exclude]
  );

  // 赶课提示：同一天相邻节次但校区不同（不阻止选课）
  const tightTransfers = await run(
    `SELECT DISTINCT
            c.name AS course_name,
            s1.weekday AS weekday,
            s1.start_period AS start_period,
            s1.end_period AS end_period,
            s1.campus AS campus,
            s2.campus AS other_campus,
            s2.start_period AS other_start_period,
            s2.end_period AS other_end_period
       FROM t_course_schedule s1
       JOIN t_course_schedule s2
         ON s2.weekday = s1.weekday
        AND (s2.start_period = s1.end_period + 1 OR s1.start_period = s2.end_period + 1)
        AND IFNULL(s1.campus,'') <> IFNULL(s2.campus,'')
        AND NOT ((s1.parity = 1 AND s2.parity = 2) OR (s1.parity = 2 AND s2.parity = 1))
       JOIN t_enrollment e
         ON e.offering_id = s2.offering_id AND e.student_id = ? AND e.status = 1
       JOIN t_course_offering o2 ON o2.id = s2.offering_id AND o2.term_id = ?
       JOIN t_course c ON c.id = o2.course_id
      WHERE s1.offering_id = ? AND s2.offering_id NOT IN (${placeholders})`,
    [studentId, termId, offeringId, ...exclude]
  );

  return { conflicts, tightTransfers };
}

/** 取本学期已选总学分与类别学分（4.4） */
async function getCreditSummary(studentId, termId, conn = null) {
  const run = runner(conn);

  const rows = await run(
    `SELECT cat.id AS category_id, cat.name AS category_name,
            SUM(c.credit) AS credit, COUNT(*) AS cnt
       FROM t_enrollment e
       JOIN t_course_offering o ON o.id = e.offering_id AND o.term_id = ?
       JOIN t_course c ON c.id = o.course_id
       JOIN t_course_category cat ON cat.id = c.category_id
      WHERE e.student_id = ? AND e.status = 1
      GROUP BY cat.id, cat.name`,
    [termId, studentId]
  );

  const byCategory = rows.map((r) => ({
    categoryId: r.category_id,
    categoryName: r.category_name,
    credit: Number(r.credit || 0),
    count: Number(r.cnt || 0),
  }));
  const total = byCategory.reduce((s, r) => s + r.credit, 0);
  return { total, byCategory };
}

/** 取本学期学分上下限（4.4） */
async function getCreditRule(termId, grade, conn = null) {
  const run = runner(conn);
  const rows = await run(`SELECT * FROM t_credit_rule WHERE term_id = ? AND grade = ?`, [termId, grade]);
  return rows.length ? rows[0] : null;
}

async function getCategoryCreditRules(termId, conn = null) {
  return runner(conn)(
    `SELECT r.*, c.name AS category_name
       FROM t_category_credit_rule r
       JOIN t_course_category c ON c.id = r.category_id
      WHERE r.term_id = ?`,
    [termId]
  );
}

/** 学分校验：超过上限抛 2003（下限不用于拦截，仅作预警） */
async function assertCreditNotExceed(studentId, termId, grade, addCredit, conn = null, subtractCredit = 0) {
  const rule = await getCreditRule(termId, grade, conn);
  if (!rule) return { maxCredit: null, willTotal: null };
  const summary = await getCreditSummary(studentId, termId, conn);
  const willTotal = summary.total - Number(subtractCredit || 0) + Number(addCredit || 0);
  if (willTotal > Number(rule.max_credit)) {
    throw new AppError(
      CODES.CREDIT_EXCEED,
      `选课后本学期总学分为 ${willTotal}，将超出上限 ${Number(rule.max_credit)} 学分`,
      { currentCredit: summary.total, addCredit: Number(addCredit), maxCredit: Number(rule.max_credit) }
    );
  }
  return { maxCredit: Number(rule.max_credit), willTotal, currentCredit: summary.total };
}

/**
 * 先修校验（4.7）。支持「与」（全部满足）与「或」（满足其一）两种类型。
 * 未满足抛 2004 并指明缺失的先修课程。
 */
async function assertPrereqSatisfied(studentId, courseId, conn = null) {
  const run = runner(conn);

  const rows = await run(
    `SELECT p.require_type, p.group_no,
            c.id AS prereq_id, c.name AS prereq_name, c.course_code,
            IFNULL(h.is_passed, 0) AS passed
       FROM t_course_prereq p
       JOIN t_course c ON c.id = p.prereq_course_id
       LEFT JOIN t_student_course_history h
              ON h.course_id = p.prereq_course_id AND h.student_id = ?
      WHERE p.course_id = ?`,
    [studentId, courseId]
  );

  if (!rows.length) return { required: [], missing: [] };

  const missing = [];

  // 「与」关系：每一条都必须通过
  rows
    .filter((r) => r.require_type === 1)
    .forEach((r) => {
      if (!r.passed) missing.push({ name: r.prereq_name, code: r.course_code, groupNo: r.group_no });
    });

  // 「或」关系：同组内满足其一即可
  const orGroups = new Map();
  rows
    .filter((r) => r.require_type === 2)
    .forEach((r) => {
      if (!orGroups.has(r.group_no)) orGroups.set(r.group_no, []);
      orGroups.get(r.group_no).push(r);
    });
  for (const [groupNo, group] of orGroups.entries()) {
    if (!group.some((g) => g.passed)) {
      group.forEach((g) => missing.push({ name: g.prereq_name, code: g.course_code, groupNo }));
    }
  }

  if (missing.length) {
    const text = missing.map((m) => `《${m.name}》`).join('、');
    throw new AppError(CODES.PREREQ_NOT_MET, `需先修并通过指定先修课程：${text}`, { missing });
  }
  return { required: rows, missing: [] };
}

/** 退课截止时间（4.6）：补退选批次结束后的第 N 天 23:59 */
async function getDropDeadline(termId, conn = null) {
  const rows = await runner(conn)(
    `SELECT MAX(end_time) AS t FROM t_enroll_batch WHERE term_id = ? AND type = 2 AND status = 1`,
    [termId]
  );
  const base = rows.length && rows[0].t ? new Date(rows[0].t) : null;
  if (!base) return null;
  const deadline = new Date(base);
  deadline.setDate(deadline.getDate() + config.business.dropDeadlineDaysAfterBatch);
  deadline.setHours(23, 59, 0, 0);
  return deadline;
}

/** 是否已过退课截止 */
async function assertDropAllowed(termId, at = new Date(), conn = null) {
  const deadline = await getDropDeadline(termId, conn);
  if (deadline && at > deadline) {
    throw new AppError(CODES.DROP_CLOSED, `已超过退课截止时间（${fmt(deadline)}），无法退课`, {
      deadline,
    });
  }
  return deadline;
}

/** 竞争热度口径（4.2 / 3.2.2）：利用率 = 已选 / 容量，≥90% 高、60%~90% 中、<60% 低 */
function heatOf(enrolled, capacity) {
  if (!capacity) return '低';
  const rate = enrolled / capacity;
  if (rate >= 0.9) return '高';
  if (rate >= 0.6) return '中';
  return '低';
}

module.exports = {
  getCurrentTerm,
  getTermById,
  resolveBatch,
  assertInBatch,
  detectConflict,
  getCreditSummary,
  getCreditRule,
  getCategoryCreditRules,
  assertCreditNotExceed,
  assertPrereqSatisfied,
  getDropDeadline,
  assertDropAllowed,
  heatOf,
  fmt,
};
