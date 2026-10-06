'use strict';

/**
 * 课程查询与状态标注服务（见设计文档 3.2.2 课程查询与浏览页、表 6 选课按钮状态）。
 */

const db = require('../db');
const rules = require('./ruleService');
const period = require('../utils/period');

const WEEKDAY_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PARITY_TEXT = { 0: '全周', 1: '单周', 2: '双周' };

function scheduleText(s) {
  const parity = s.parity ? `（${PARITY_TEXT[s.parity]}）` : '';
  const place = [s.campus, s.building, s.room].filter(Boolean).join(' ');
  const time = period.rangeText(s.start_period, s.end_period);
  return `${WEEKDAY_TEXT[s.weekday]} 第 ${s.start_period}-${s.end_period} 节${
    time ? ` ${time}` : ''
  }${parity}${place ? ' · ' + place : ''}`;
}

function weekdayText(n) {
  return WEEKDAY_TEXT[n] || '';
}

function parityText(n) {
  return PARITY_TEXT[n] || '全周';
}

/** 为一批开课挂载排课时段 */
async function attachSchedules(offerings) {
  if (!offerings.length) return offerings;
  const ids = offerings.map((o) => o.offering_id);
  const rows = await db.query(
    `SELECT * FROM t_course_schedule WHERE offering_id IN (?) ORDER BY weekday, start_period`,
    [ids]
  );
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.offering_id)) map.set(r.offering_id, []);
    map.get(r.offering_id).push(r);
  });
  offerings.forEach((o) => {
    o.schedules = map.get(o.offering_id) || [];
    o.scheduleText = o.schedules.map(scheduleText);
  });
  return offerings;
}

/** 基础查询：按条件筛选开课 */
async function queryOfferings({
  termId,
  keyword,
  categoryId,
  weekday,
  available,
  campus,
  status,
  page = 1,
  size = 10,
  sort = 'code',
}) {
  const where = ['o.term_id = ?'];
  const params = [termId];

  if (keyword) {
    where.push('(c.name LIKE ? OR c.course_code LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (categoryId) {
    where.push('c.category_id = ?');
    params.push(categoryId);
  }
  if (campus) {
    where.push('o.campus = ?');
    params.push(campus);
  }
  if (status !== undefined && status !== null && status !== '') {
    where.push('o.status = ?');
    params.push(Number(status));
  }
  if (String(available) === 'true') {
    where.push('o.status = 1 AND o.enrolled < o.capacity');
  }
  if (weekday) {
    where.push('EXISTS (SELECT 1 FROM t_course_schedule s WHERE s.offering_id = o.id AND s.weekday = ?)');
    params.push(Number(weekday));
  }

  const orderBy =
    sort === 'heat'
      ? 'o.enrolled / o.capacity DESC, c.course_code'
      : sort === 'enrolled'
      ? 'o.enrolled DESC, c.course_code'
      : 'c.course_code, c.name';

  const whereSql = where.join(' AND ');
  const totalRow = await db.queryOne(
    `SELECT COUNT(*) AS total
       FROM t_course_offering o
       JOIN t_course c ON c.id = o.course_id
      WHERE ${whereSql}`,
    params
  );

  const offset = (Number(page) - 1) * Number(size);
  const rows = await db.query(
    `SELECT o.id AS offering_id, o.capacity, o.enrolled, o.status AS offering_status,
            o.campus AS offering_campus, o.remark,
            c.id AS course_id, c.course_code, c.name AS course_name, c.credit,
            c.dept, c.description,
            cat.id AS category_id, cat.name AS category_name,
            t.id AS teacher_id, tu.real_name AS teacher_name, t.title AS teacher_title
       FROM t_course_offering o
       JOIN t_course c ON c.id = o.course_id
       JOIN t_course_category cat ON cat.id = c.category_id
       JOIN t_teacher t ON t.id = o.teacher_id
       JOIN t_user tu ON tu.id = t.user_id
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, Number(size), offset]
  );

  return { rows, total: Number(totalRow.total) };
}

/**
 * 批量标注选课状态（表 6）。
 * 一次查询完成：已选集合、候补集合、冲突映射、先修满足情况，避免逐行查询。
 */
async function annotateOfferings(offerings, ctx) {
  if (!offerings.length) return offerings;
  const { studentId, termId, student, batchInfo, creditInfo } = ctx;
  const offeringIds = offerings.map((o) => o.offering_id);

  // 1) 已选 / 退课中
  const myEnroll = await db.query(
    `SELECT offering_id, status, source, select_time FROM t_enrollment
      WHERE student_id = ? AND offering_id IN (?)`,
    [studentId, offeringIds]
  );
  const selectedMap = new Map();
  myEnroll.forEach((r) => {
    if (r.status === 1) selectedMap.set(r.offering_id, r);
  });

  // 2) 候补中
  const myWait = await db.query(
    `SELECT offering_id, queue_no, status FROM t_waitlist
      WHERE student_id = ? AND offering_id IN (?) AND status = 1`,
    [studentId, offeringIds]
  );
  const waitMap = new Map(myWait.map((r) => [r.offering_id, r]));

  // 3) 候补总人数
  const waitCount = await db.query(
    `SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist
      WHERE offering_id IN (?) AND status = 1 GROUP BY offering_id`,
    [offeringIds]
  );
  const waitCountMap = new Map(waitCount.map((r) => [r.offering_id, Number(r.cnt)]));

  // 4) 冲突映射：一次性比对本页全部开课与本人已选开课的排课
  const conflictRows = await db.query(
    `SELECT DISTINCT s1.offering_id AS offering_id,
            c2.name AS other_course_name, c2.course_code AS other_course_code,
            s1.weekday AS weekday, s1.start_period AS start_period, s1.end_period AS end_period,
            s1.parity AS parity,
            s2.start_period AS other_start_period, s2.end_period AS other_end_period,
            s2.parity AS other_parity, s1.campus AS campus, s2.campus AS other_campus
       FROM t_course_schedule s1
       JOIN t_course_schedule s2
         ON s2.weekday = s1.weekday
        AND s1.start_period <= s2.end_period
        AND s2.start_period <= s1.end_period
        AND NOT ((s1.parity = 1 AND s2.parity = 2) OR (s1.parity = 2 AND s2.parity = 1))
       JOIN t_enrollment e ON e.offering_id = s2.offering_id AND e.student_id = ? AND e.status = 1
       JOIN t_course_offering o2 ON o2.id = s2.offering_id AND o2.term_id = ?
       JOIN t_course c2 ON c2.id = o2.course_id
      WHERE s1.offering_id IN (?) AND s2.offering_id <> s1.offering_id`,
    [studentId, termId, offeringIds]
  );
  const conflictMap = new Map();
  conflictRows.forEach((r) => {
    if (!conflictMap.has(r.offering_id)) conflictMap.set(r.offering_id, []);
    conflictMap.get(r.offering_id).push({
      courseName: r.other_course_name,
      courseCode: r.other_course_code,
      weekday: r.weekday,
      weekdayText: weekdayText(r.weekday),
      parityText: parityText(r.parity),
      otherParityText: parityText(r.other_parity),
      periods: `${r.start_period}-${r.end_period} 节`,
      otherPeriods: `${r.other_start_period}-${r.other_end_period} 节`,
      campus: r.campus,
      otherCampus: r.other_campus,
    });
  });

  // 5) 先修满足情况：一次性取本页课程的全部先修要求
  const courseIds = [...new Set(offerings.map((o) => o.course_id))];
  const prereqRows = await db.query(
    `SELECT p.course_id, p.require_type, p.group_no,
            c.name AS prereq_name, c.course_code,
            IFNULL(h.is_passed, 0) AS passed
       FROM t_course_prereq p
       JOIN t_course c ON c.id = p.prereq_course_id
       LEFT JOIN t_student_course_history h
              ON h.course_id = p.prereq_course_id AND h.student_id = ?
      WHERE p.course_id IN (?)`,
    [studentId, courseIds]
  );
  const prereqMap = new Map();
  prereqRows.forEach((r) => {
    if (!prereqMap.has(r.course_id)) prereqMap.set(r.course_id, []);
    prereqMap.get(r.course_id).push(r);
  });

  function prereqMiss(courseId) {
    const rows = prereqMap.get(courseId) || [];
    if (!rows.length) return [];
    const miss = [];
    rows.filter((r) => r.require_type === 1).forEach((r) => {
      if (!r.passed) miss.push(r.prereq_name);
    });
    const groups = new Map();
    rows.filter((r) => r.require_type === 2).forEach((r) => {
      if (!groups.has(r.group_no)) groups.set(r.group_no, []);
      groups.get(r.group_no).push(r);
    });
    groups.forEach((g) => {
      if (!g.some((x) => x.passed)) g.forEach((x) => miss.push(x.prereq_name));
    });
    return [...new Set(miss)];
  }

  const batchOk = !!batchInfo.batch;
  const maxCredit = creditInfo.rule ? Number(creditInfo.rule.max_credit) : null;

  offerings.forEach((o) => {
    const selected = selectedMap.get(o.offering_id);
    const wait = waitMap.get(o.offering_id);
    const conflicts = conflictMap.get(o.offering_id) || [];
    const missPrereq = prereqMiss(o.course_id);
    const willTotal = creditInfo.total + Number(o.credit);
    const creditExceed = maxCredit !== null && willTotal > maxCredit;
    const full = o.enrolled >= o.capacity || o.offering_status === 2;
    const closed = o.offering_status === 0;

    const reasons = [];
    if (conflicts.length) {
      reasons.push({
        code: 2002,
        text: `与《${conflicts[0].courseName}》冲突（${conflicts[0].weekdayText} ${conflicts[0].periods}）`,
      });
    }
    if (creditExceed) reasons.push({ code: 2003, text: `选后将达 ${willTotal} 学分，超出上限 ${maxCredit}` });
    if (missPrereq.length) reasons.push({ code: 2004, text: `需先修：${missPrereq.join('、')}` });
    if (!batchOk) reasons.push({ code: 2005, text: '当前不在你的选课批次时间内' });
    if (full) reasons.push({ code: 2001, text: '名额已满，可加入候补' });

    let status = 'AVAILABLE';
    if (closed) status = 'CLOSED';
    else if (selected) status = 'SELECTED';
    else if (wait) status = 'WAITLISTED';
    else if (!batchOk) status = 'OUT_OF_BATCH';
    else if (full) status = 'FULL';
    else if (conflicts.length) status = 'CONFLICT';
    else if (creditExceed || missPrereq.length) status = 'INELIGIBLE';

    o.status = status;
    o.selectable = status === 'AVAILABLE';
    o.waitlistable = (status === 'FULL' || status === 'CLOSED') && !selected && !wait;
    o.willTotalCredit = willTotal;
    o.heat = rules.heatOf(o.enrolled, o.capacity);
    o.reasons = reasons;
    o.conflicts = conflicts;
    o.missingPrereq = missPrereq;
    o.myEnrollment = selected
      ? { status: selected.status, source: selected.source, selectTime: selected.select_time }
      : null;
    o.myWaitlist = wait ? { queueNo: wait.queue_no, status: wait.status } : null;
    o.waitlistCount = waitCountMap.get(o.offering_id) || 0;
    o.remaining = Math.max(0, o.capacity - o.enrolled);
  });

  return offerings;
}

/** 组装学生侧的选课上下文（批次、学分、先修） */
async function buildStudentContext(student, termId) {
  const batchInfo = await rules.resolveBatch(termId, student);
  const creditInfo = await rules.getCreditSummary(student.id, termId);
  const rule = await rules.getCreditRule(termId, student.grade);
  const categoryRules = await rules.getCategoryCreditRules(termId);
  const dropDeadline = await rules.getDropDeadline(termId);
  return {
    studentId: student.id,
    student,
    termId,
    batchInfo,
    creditInfo: { ...creditInfo, rule },
    categoryRules,
    dropDeadline,
  };
}

/** 开课详情：含排课、余量、热度、先修要求、可选状态 */
async function getOfferingDetail(offeringId, ctx) {
  const rows = await db.query(
    `SELECT o.id AS offering_id, o.capacity, o.enrolled, o.status AS offering_status,
            o.campus AS offering_campus, o.remark,
            c.id AS course_id, c.course_code, c.name AS course_name, c.credit,
            c.dept, c.description,
            cat.id AS category_id, cat.name AS category_name,
            t.id AS teacher_id, tu.real_name AS teacher_name, t.title AS teacher_title, t.college AS teacher_college
       FROM t_course_offering o
       JOIN t_course c ON c.id = o.course_id
       JOIN t_course_category cat ON cat.id = c.category_id
       JOIN t_teacher t ON t.id = o.teacher_id
       JOIN t_user tu ON tu.id = t.user_id
      WHERE o.id = ? AND o.term_id = ?`,
    [offeringId, ctx.termId]
  );
  if (!rows.length) return null;
  await attachSchedules(rows);
  await annotateOfferings(rows, ctx);

  const o = rows[0];
  const prereqRows = await db.query(
    `SELECT p.require_type, p.group_no, c.name AS prereq_name, c.course_code,
            IFNULL(h.is_passed, 0) AS passed
       FROM t_course_prereq p
       JOIN t_course c ON c.id = p.prereq_course_id
       LEFT JOIN t_student_course_history h
              ON h.course_id = p.prereq_course_id AND h.student_id = ?
      WHERE p.course_id = ?`,
    [ctx.studentId, o.course_id]
  );
  o.prereqList = prereqRows.map((r) => ({
    name: r.prereq_name,
    code: r.course_code,
    requireType: r.require_type,
    groupNo: r.group_no,
    passed: !!r.passed,
  }));

  const queue = await db.query(
    `SELECT w.queue_no, s.student_no, u.real_name
       FROM t_waitlist w
       JOIN t_student s ON s.id = w.student_id
       JOIN t_user u ON u.id = s.user_id
      WHERE w.offering_id = ? AND w.status = 1
      ORDER BY w.queue_no LIMIT 10`,
    [offeringId]
  );
  o.waitlistQueue = queue.map((q) => ({ queueNo: q.queue_no, studentNo: q.student_no, name: q.real_name }));
  return o;
}

module.exports = {
  WEEKDAY_TEXT,
  PARITY_TEXT,
  weekdayText,
  parityText,
  scheduleText,
  attachSchedules,
  queryOfferings,
  annotateOfferings,
  buildStudentContext,
  getOfferingDetail,
};
