'use strict';

/**
 * 静态版 · 选课规则引擎
 * 与 server/services/ruleService.js 一一对应（行为保持一致，仅把 SQL 换成内存表操作）。
 */

const WEEKDAY_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PARITY_TEXT = { 0: '全周', 1: '单周', 2: '双周' };

function weekdayText(n) {
  return WEEKDAY_TEXT[n] || '';
}

function parityText(n) {
  return PARITY_TEXT[n] || '全周';
}

/** 'YYYY-MM-DD HH:mm'，用于提示文案 */
function fmt(v) {
  const d = toDate(v);
  if (!d) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`;
}

/** 取当前学期；无 is_current 时取最新学期 */
function getCurrentTerm() {
  const rows = [...tbl('t_term')].sort((a, b) => {
    if (Number(b.is_current) !== Number(a.is_current)) return Number(b.is_current) - Number(a.is_current);
    return String(b.start_date).localeCompare(String(a.start_date));
  });
  return rows.length ? rows[0] : null;
}

function getTermById(termId) {
  return findById('t_term', termId);
}

/* ------------------------------------------------------------------ */
/* 批次准入（4.1 / 4.5 第一层）                                        */
/* ------------------------------------------------------------------ */

/**
 * 一名学生可能命中多个批次，取「优先级最高（priority 最小）且时间窗口命中」的批次。
 * 返回 { batch, matches, next }
 */
function resolveBatch(termId, student, at) {
  const when = at instanceof Date ? at : toDate(at) || new Date();
  const rows = tbl('t_enroll_batch')
    .filter((b) => Number(b.term_id) === Number(termId) && Number(b.status) === 1)
    .sort((a, b) => {
      const p = Number(a.priority) - Number(b.priority);
      if (p !== 0) return p;
      return String(a.start_time).localeCompare(String(b.start_time));
    });

  const matched = rows.filter((b) => {
    const gradeOk =
      !b.target_grade ||
      String(b.target_grade)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(student.grade);
    const collegeOk = !b.target_college || String(b.target_college).includes(student.college);
    return gradeOk && collegeOk;
  });

  const inWindow = matched.filter((b) => {
    const s = toDate(b.start_time);
    const e = toDate(b.end_time);
    return when >= s && when <= e;
  });

  return {
    batch: inWindow.length ? inWindow[0] : null,
    matches: matched,
    next: matched.find((b) => toDate(b.start_time) > when) || null,
  };
}

/** 批次校验：不在窗口内抛 2005 */
function assertInBatch(termId, student, at) {
  const { batch, next } = resolveBatch(termId, student, at);
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

/* ------------------------------------------------------------------ */
/* 时间冲突检测（4.3）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 判定条件：weekday 相同，且节次区间相交，且单双周不互斥。
 * 一门课存在多个时段时，任一时段冲突即整体冲突。
 */
function detectConflict(offeringId, studentId, termId, excludeOfferingIds) {
  const exclude = [Number(offeringId), ...(excludeOfferingIds || []).map(Number)].filter(
    (x) => x !== null && x !== undefined && !Number.isNaN(x)
  );

  const mySchedule = tbl('t_course_schedule').filter((s) => !exclude.includes(Number(s.offering_id)));
  const myOfferingIds = new Set(
    tbl('t_enrollment')
      .filter((e) => Number(e.student_id) === Number(studentId) && Number(e.status) === 1)
      .map((e) => Number(e.offering_id))
  );

  const s1List = tbl('t_course_schedule').filter((s) => Number(s.offering_id) === Number(offeringId));
  const conflicts = [];
  const tightTransfers = [];

  s1List.forEach((s1) => {
    mySchedule.forEach((s2) => {
      if (!myOfferingIds.has(Number(s2.offering_id))) return;
      const o2 = findById('t_course_offering', s2.offering_id);
      if (!o2 || Number(o2.term_id) !== Number(termId)) return;
      const course = findById('t_course', o2.course_id);
      if (!course) return;

      if (Number(s2.weekday) !== Number(s1.weekday)) return;
      const parityExclusive =
        (Number(s1.parity) === 1 && Number(s2.parity) === 2) ||
        (Number(s1.parity) === 2 && Number(s2.parity) === 1);
      if (parityExclusive) return;

      const overlap = Number(s1.start_period) <= Number(s2.end_period) && Number(s2.start_period) <= Number(s1.end_period);
      if (overlap) {
        if (!conflicts.some((c) => Number(c.offering_id) === Number(s2.offering_id) && c.weekday === s1.weekday)) {
          conflicts.push({
            course_name: course.name,
            course_code: course.course_code,
            offering_id: Number(s2.offering_id),
            weekday: Number(s1.weekday),
            start_period: Number(s1.start_period),
            end_period: Number(s1.end_period),
            parity: Number(s1.parity),
            other_start_period: Number(s2.start_period),
            other_end_period: Number(s2.end_period),
            other_parity: Number(s2.parity),
            campus: s1.campus,
            other_campus: s2.campus,
          });
        }
        return;
      }

      // 赶课提示：同一天相邻节次但校区不同（不阻止选课）
      const adjacent =
        Number(s2.start_period) === Number(s1.end_period) + 1 || Number(s1.start_period) === Number(s2.end_period) + 1;
      const campusDiff = String(s1.campus || '') !== String(s2.campus || '');
      if (adjacent && campusDiff) {
        if (!tightTransfers.some((t) => Number(t.offering_id) === Number(s2.offering_id))) {
          tightTransfers.push({
            offering_id: Number(s2.offering_id),
            course_name: course.name,
            weekday: Number(s1.weekday),
            start_period: Number(s1.start_period),
            end_period: Number(s1.end_period),
            campus: s1.campus,
            other_campus: s2.campus,
            other_start_period: Number(s2.start_period),
            other_end_period: Number(s2.end_period),
          });
        }
      }
    });
  });

  return { conflicts, tightTransfers };
}

/* ------------------------------------------------------------------ */
/* 学分（4.4）                                                         */
/* ------------------------------------------------------------------ */

/** 取本学期已选总学分与类别学分 */
function getCreditSummary(studentId, termId) {
  const map = new Map();
  tbl('t_enrollment')
    .filter((e) => Number(e.student_id) === Number(studentId) && Number(e.status) === 1)
    .forEach((e) => {
      const o = findById('t_course_offering', e.offering_id);
      if (!o || Number(o.term_id) !== Number(termId)) return;
      const c = findById('t_course', o.course_id);
      if (!c) return;
      const cat = findById('t_course_category', c.category_id);
      const key = c.category_id;
      if (!map.has(key)) {
        map.set(key, {
          categoryId: Number(c.category_id),
          categoryName: cat ? cat.name : '',
          credit: 0,
          count: 0,
        });
      }
      const item = map.get(key);
      item.credit += Number(c.credit || 0);
      item.count += 1;
    });

  const byCategory = [...map.values()];
  const total = byCategory.reduce((s, r) => s + r.credit, 0);
  return { total, byCategory };
}

function getCreditRule(termId, grade) {
  const rows = tbl('t_credit_rule').filter(
    (r) => Number(r.term_id) === Number(termId) && String(r.grade) === String(grade)
  );
  return rows.length ? rows[0] : null;
}

function getCategoryCreditRules(termId) {
  return tbl('t_category_credit_rule')
    .filter((r) => Number(r.term_id) === Number(termId))
    .map((r) => {
      const c = findById('t_course_category', r.category_id);
      return { ...r, category_name: c ? c.name : '' };
    });
}

/** 学分校验：超过上限抛 2003（下限不用于拦截，仅作预警） */
function assertCreditNotExceed(studentId, termId, grade, addCredit, subtractCredit) {
  const rule = getCreditRule(termId, grade);
  if (!rule) return { maxCredit: null, willTotal: null };
  const summary = getCreditSummary(studentId, termId);
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

/* ------------------------------------------------------------------ */
/* 先修（4.7）                                                         */
/* ------------------------------------------------------------------ */

/** 支持「与」（全部满足）与「或」（满足其一）两种类型；未满足抛 2004 */
function assertPrereqSatisfied(studentId, courseId) {
  const rows = tbl('t_course_prereq')
    .filter((p) => Number(p.course_id) === Number(courseId))
    .map((p) => {
      const c = findById('t_course', p.prereq_course_id);
      const h = tbl('t_student_course_history').find(
        (x) => Number(x.course_id) === Number(p.prereq_course_id) && Number(x.student_id) === Number(studentId)
      );
      return {
        require_type: Number(p.require_type),
        group_no: Number(p.group_no),
        prereq_id: Number(p.prereq_course_id),
        prereq_name: c ? c.name : '',
        course_code: c ? c.course_code : '',
        passed: h ? Number(h.is_passed) : 0,
      };
    });

  if (!rows.length) return { required: [], missing: [] };

  const missing = [];

  rows
    .filter((r) => r.require_type === 1)
    .forEach((r) => {
      if (!r.passed) missing.push({ name: r.prereq_name, code: r.course_code, groupNo: r.group_no });
    });

  const orGroups = new Map();
  rows
    .filter((r) => r.require_type === 2)
    .forEach((r) => {
      if (!orGroups.has(r.group_no)) orGroups.set(r.group_no, []);
      orGroups.get(r.group_no).push(r);
    });
  orGroups.forEach((group, groupNo) => {
    if (!group.some((g) => g.passed)) {
      group.forEach((g) => missing.push({ name: g.prereq_name, code: g.course_code, groupNo }));
    }
  });

  if (missing.length) {
    const text = missing.map((m) => `《${m.name}》`).join('、');
    throw new AppError(CODES.PREREQ_NOT_MET, `需先修并通过指定先修课程：${text}`, { missing });
  }
  return { required: rows, missing: [] };
}

/* ------------------------------------------------------------------ */
/* 退课截止（4.6）                                                     */
/* ------------------------------------------------------------------ */

/** 退课截止时间：补退选批次结束后的第 N 天 23:59 */
function getDropDeadline(termId) {
  const rows = tbl('t_enroll_batch').filter(
    (b) => Number(b.term_id) === Number(termId) && Number(b.type) === 2 && Number(b.status) === 1
  );
  if (!rows.length) return null;
  const baseStr = rows.map((b) => b.end_time).sort().pop();
  const base = toDate(baseStr);
  if (!base) return null;
  const deadline = new Date(base);
  deadline.setDate(deadline.getDate() + CONFIG.business.dropDeadlineDaysAfterBatch);
  deadline.setHours(23, 59, 0, 0);
  return deadline;
}

function assertDropAllowed(termId, at) {
  const when = at instanceof Date ? at : new Date();
  const deadline = getDropDeadline(termId);
  if (deadline && when > deadline) {
    throw new AppError(CODES.DROP_CLOSED, `已超过退课截止时间（${fmt(deadline)}），无法退课`, { deadline });
  }
  return deadline;
}

/* ------------------------------------------------------------------ */
/* 竞争热度（4.2 / 3.2.2）                                             */
/* ------------------------------------------------------------------ */

/** 利用率 = 已选 / 容量，≥90% 高、60%~90% 中、<60% 低 */
function heatOf(enrolled, capacity) {
  if (!capacity) return '低';
  const rate = Number(enrolled) / Number(capacity);
  if (rate >= 0.9) return '高';
  if (rate >= 0.6) return '中';
  return '低';
}

module.exports = {
  WEEKDAY_TEXT,
  PARITY_TEXT,
  weekdayText,
  parityText,
  fmt,
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
};
