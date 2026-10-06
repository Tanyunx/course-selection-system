'use strict';

/**
 * 端到端验收测试：逐条验证设计文档表 28 的关键验收用例。
 * 用法：node tests/acceptance.js
 *
 * 测试会在数据库中创建带 ZZTEST 前缀的临时数据，执行结束后自动清理。
 */

const mysql = require('mysql2/promise');
const config = require('../config/config');
const pwd = require('../src/utils/password');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const DEMO_PWD = '123456';

let conn;

/* ---------------- 基础设施 ---------------- */

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
}
function assertCase(id, name, cond, detail) {
  record(id, name, cond, detail);
}

async function sql(q, p = []) {
  const [rows] = await conn.query(q, p);
  return rows;
}

async function apiCall(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

async function login(username, password = DEMO_PWD) {
  const r = await apiCall('POST', '/api/auth/login', { body: { username, password } });
  if (!r || r.code !== 0) throw new Error(`登录失败 ${username}: ${r && r.message}`);
  return r.data.token;
}

function rid() {
  return 'zz-' + Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
}

/* ---------------- 测试数据准备 ---------------- */

const FIX = {};

/** 清理全部本次测试产生的临时数据（幂等，可在任意阶段调用） */
async function purge() {
  const testUsers = `SELECT id FROM t_user WHERE username LIKE 'ZZTEST%' OR username LIKE 'ZZTEACH%'`;
  const testStudents = `SELECT id FROM t_student WHERE student_no LIKE 'ZZTEST%'`;
  const offs = await sql(
    `SELECT o.id FROM t_course_offering o JOIN t_course c ON c.id = o.course_id WHERE c.course_code LIKE 'ZZC%'`
  );
  const offIds = offs.map((o) => o.id);

  await sql(`DELETE FROM t_notice WHERE user_id IN (${testUsers})`);
  await sql(`DELETE FROM t_audit_log WHERE username LIKE 'ZZTEST%' OR username LIKE 'ZZTEACH%' OR detail LIKE '%ZZ测试%'`);
  await sql(`DELETE FROM t_enrollment WHERE student_id IN (${testStudents})`);
  await sql(`DELETE FROM t_waitlist WHERE student_id IN (${testStudents})`);
  if (offIds.length) {
    await sql(`DELETE FROM t_enrollment WHERE offering_id IN (?)`, [offIds]);
    await sql(`DELETE FROM t_waitlist WHERE offering_id IN (?)`, [offIds]);
    await sql(`DELETE FROM t_course_schedule WHERE offering_id IN (?)`, [offIds]);
    await sql(`DELETE FROM t_course_offering WHERE id IN (?)`, [offIds]);
  }
  await sql(
    `DELETE FROM t_course_prereq WHERE course_id IN (SELECT id FROM t_course WHERE course_code LIKE 'ZZC%')
        OR prereq_course_id IN (SELECT id FROM t_course WHERE course_code LIKE 'ZZC%')`
  );
  await sql(`DELETE FROM t_course WHERE course_code LIKE 'ZZC%'`);
  await sql(`DELETE FROM t_student WHERE student_no LIKE 'ZZTEST%'`);
  await sql(`DELETE FROM t_teacher WHERE teacher_no LIKE 'ZZTEACH%'`);
  await sql(`DELETE FROM t_user WHERE username LIKE 'ZZTEST%' OR username LIKE 'ZZTEACH%'`);
}

async function setup() {
  await purge();

  const [term] = await sql(`SELECT * FROM t_term WHERE is_current = 1 LIMIT 1`);
  FIX.termId = term.id;

  const [cat] = await sql(`SELECT id FROM t_course_category WHERE code = 'MAJ' LIMIT 1`);
  FIX.majorCat = cat.id;

  const [batch] = await sql(`SELECT id FROM t_enroll_batch WHERE term_id = ? ORDER BY priority LIMIT 1`, [FIX.termId]);
  FIX.batchId = batch.id;

  // 统一的密码哈希（bcrypt 计算一次，复用给全部临时账号）
  FIX.hash = pwd.hash(DEMO_PWD);

  // 用于 TC-01 的 100 名学生
  FIX.students = [];
  const hashEsc = FIX.hash.replace(/'/g, "''");
  const valuesSql = [];
  for (let i = 1; i <= 100; i += 1) {
    const no = `ZZTEST${String(i).padStart(3, '0')}`;
    valuesSql.push(`('${no}','${hashEsc}','测试学生${i}',1,1)`);
    FIX.students.push({ username: no, index: i });
  }
  await sql(`INSERT INTO t_user (username, password_hash, real_name, role, status) VALUES ${valuesSql.join(',')}`);
  const users = await sql(
    `SELECT id, username FROM t_user WHERE username LIKE 'ZZTEST%' ORDER BY username`
  );
  FIX.userIdByUsername = new Map(users.map((u) => [u.username, u.id]));

  const studentValues = users
    .map((u) => `(${u.id},'${u.username}','2024','计算机学院','软件工程')`)
    .join(',');
  await sql(`INSERT INTO t_student (user_id, student_no, grade, college, major) VALUES ${studentValues}`);

  const stus = await sql(`SELECT id, student_no FROM t_student WHERE student_no LIKE 'ZZTEST%'`);
  FIX.studentIdByNo = new Map(stus.map((s) => [s.student_no, s.id]));

  // 若干配套测试课程
  await sql(
    `INSERT INTO t_course (course_code, name, category_id, credit, dept, status) VALUES
      ('ZZC001','ZZ测试课程甲',?,2.0,'测试单位',1),
      ('ZZC002','ZZ测试课程乙',?,2.0,'测试单位',1),
      ('ZZC003','ZZ测试课程丙',?,2.0,'测试单位',1),
      ('ZZC004','ZZ测试课程丁',?,2.0,'测试单位',1)`,
    [FIX.majorCat, FIX.majorCat, FIX.majorCat, FIX.majorCat]
  );
  const courses = await sql(`SELECT id, course_code FROM t_course WHERE course_code LIKE 'ZZC%'`);
  FIX.courseByCode = new Map(courses.map((c) => [c.course_code, c.id]));

  // 为每个测试开课准备独立教师，避免 (course_id, term_id, teacher_id) 唯一约束冲突
  const teacherSql = [];
  for (let i = 1; i <= 40; i += 1) {
    const no = `ZZTEACH${String(i).padStart(3, '0')}`;
    teacherSql.push(`('${no}','${hashEsc}','测试教师${i}',2,1)`);
  }
  await sql(`INSERT INTO t_user (username, password_hash, real_name, role, status) VALUES ${teacherSql.join(',')}`);
  const tusers = await sql(`SELECT id, username FROM t_user WHERE username LIKE 'ZZTEACH%' ORDER BY username`);
  await sql(
    `INSERT INTO t_teacher (user_id, teacher_no, college, title) VALUES ${tusers
      .map((u) => `(${u.id},'${u.username}','ZZ测试学院','讲师')`)
      .join(',')}`
  );
  const teachers = await sql(`SELECT id FROM t_teacher WHERE teacher_no LIKE 'ZZTEACH%' ORDER BY id`);
  FIX.teacherPool = teachers.map((t) => t.id);

  // 测试用开课：TC-01 抢课
  FIX.offeringRush = await createOffering('ZZC001', 5, [{ weekday: 6, startPeriod: 1, endPeriod: 2, parity: 0 }]);
  FIX.offeringA = await createOffering('ZZC002', 40, [{ weekday: 1, startPeriod: 5, endPeriod: 6, parity: 0 }]);
  FIX.offeringB = await createOffering('ZZC003', 40, [{ weekday: 1, startPeriod: 5, endPeriod: 6, parity: 0 }]);
}

async function createOffering(courseCode, capacity, schedules) {
  const courseId = FIX.courseByCode.get(courseCode);
  const teacherId = FIX.teacherPool.shift();
  if (!teacherId) throw new Error('测试教师池已用尽，请扩大 FIX.teacherPool');
  const r = await sql(
    `INSERT INTO t_course_offering (course_id, term_id, teacher_id, capacity, enrolled, status, campus)
     VALUES (?, ?, ?, ?, 0, 1, 'ZZ测试校区')`,
    [courseId, FIX.termId, teacherId, capacity]
  );
  const offeringId = r.insertId;
  for (const s of schedules) {
    await sql(
      `INSERT INTO t_course_schedule (offering_id, weekday, start_period, end_period, parity, campus, building, room)
       VALUES (?, ?, ?, ?, ?, 'ZZ测试校区', 'ZZ楼', 'ZZ01')`,
      [offeringId, s.weekday, s.startPeriod, s.endPeriod, s.parity]
    );
  }
  return offeringId;
}

async function teardown() {
  await purge();
}

/* ---------------- 各条用例 ---------------- */

async function tc01() {
  const tokens = [];
  for (const s of FIX.students) tokens.push(await login(s.username));

  const reqs = tokens.map((t) => apiCall('POST', '/api/enrollments', { token: t, body: { offeringId: FIX.offeringRush, requestId: rid() } }));
  const all = await Promise.all(reqs);

  const okCount = all.filter((r) => r && r.code === 0).length;
  const fullCount = all.filter((r) => r && r.code === 2001).length;

  const [off] = await sql(`SELECT enrolled, capacity, status FROM t_course_offering WHERE id = ?`, [FIX.offeringRush]);
  const [cnt] = await sql(
    `SELECT COUNT(*) AS c FROM t_enrollment WHERE offering_id = ? AND status = 1`,
    [FIX.offeringRush]
  );

  assertCase(
    'TC-01',
    '100 个并发请求抢 5 个名额',
    okCount === 5 && Number(off.enrolled) === 5 && Number(cnt.c) === 5 && Number(off.enrolled) <= Number(off.capacity),
    `成功 ${okCount} 次，已满 ${fullCount} 次，enrolled=${off.enrolled}，实记录 ${cnt.c} 条`
  );
}

async function tc02() {
  const username = FIX.students[0].username;
  const token = await login(username);
  const first = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: FIX.offeringA, requestId: rid() } });
  const second = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: FIX.offeringA, requestId: rid() } });
  const sid = FIX.studentIdByNo.get(username);
  const rows = await sql(`SELECT COUNT(*) AS c FROM t_enrollment WHERE student_id = ? AND offering_id = ? AND status = 1`, [
    sid,
    FIX.offeringA,
  ]);
  assertCase(
    'TC-02',
    '同一学生重复提交同一开课（不同 requestId）',
    first.code === 0 && second.code === 2006 && Number(rows[0].c) === 1,
    `第一次 ${first.code}，第二次 ${second.code}，记录数 ${rows[0].c}`
  );
}

async function tc03() {
  const username = FIX.students[1].username;
  const token = await login(username);
  const r = rid();
  const first = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: FIX.offeringB, requestId: r } });
  const second = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: FIX.offeringB, requestId: r } });
  const sid = FIX.studentIdByNo.get(username);
  const rows = await sql(`SELECT COUNT(*) AS c FROM t_enrollment WHERE student_id = ? AND offering_id = ? AND status = 1`, [
    sid,
    FIX.offeringB,
  ]);
  assertCase(
    'TC-03',
    '同一 requestId 重复提交',
    first.code === 0 && second.code === 0 && Number(rows[0].c) === 1,
    `两次返回 code=${first.code}/${second.code}，记录数 ${rows[0].c}`
  );
}

async function tc04() {
  // 学生 1 已选 offeringA（周一 5-6 节，全周）；再选同星期、同节次、全周的开课 → 冲突
  const username = FIX.students[0].username;
  const token = await login(username);
  const conflictOffering = await createOffering('ZZC001', 40, [{ weekday: 1, startPeriod: 5, endPeriod: 6, parity: 0 }]);
  const res = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: conflictOffering, requestId: rid() } });
  const hasConflictName =
    res && res.data && res.data.conflicts && res.data.conflicts.length ? res.data.conflicts[0].course_name : '';
  assertCase(
    'TC-04',
    '选课与已选课程星期相同、节次相交、均为全周',
    res && res.code === 2002 && !!hasConflictName,
    `code=${res && res.code}，提示冲突课程=${hasConflictName}`
  );
}

async function tc05() {
  // 学生 2 选修单周课程，再选同节次的双周课程，应允许
  const username = FIX.students[2].username;
  const token = await login(username);
  const odd = await createOffering('ZZC002', 40, [{ weekday: 2, startPeriod: 3, endPeriod: 4, parity: 1 }]);
  const even = await createOffering('ZZC003', 40, [{ weekday: 2, startPeriod: 3, endPeriod: 4, parity: 2 }]);
  const r1 = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: odd, requestId: rid() } });
  const r2 = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: even, requestId: rid() } });
  assertCase(
    'TC-05',
    '节次相交但一为单周一为双周',
    r1.code === 0 && r2.code === 0,
    `单周课程 ${r1.code}，双周课程 ${r2.code}`
  );
}

async function tc06() {
  // 学生 3 已选周一 5-6 节；选一门「周一 6-7 节」的多时段课程，任一时段冲突即整体冲突
  const username = FIX.students[3].username;
  const token = await login(username);
  const base = await createOffering('ZZC001', 40, [{ weekday: 1, startPeriod: 5, endPeriod: 6, parity: 0 }]);
  const r1 = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: base, requestId: rid() } });
  const multi = await createOffering('ZZC004', 40, [
    { weekday: 3, startPeriod: 1, endPeriod: 2, parity: 0 },
    { weekday: 1, startPeriod: 6, endPeriod: 7, parity: 0 },
  ]);
  const r2 = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: multi, requestId: rid() } });
  assertCase(
    'TC-06',
    '选课与该课多个时段中的任一时段冲突',
    r1.code === 0 && r2.code === 2002,
    `基础课程 ${r1.code}，多时段课程 ${r2.code}`
  );
}

async function tc07() {
  const username = FIX.students[4].username;
  const token = await login(username);
  const [rule] = await sql(`SELECT * FROM t_credit_rule WHERE term_id = ? AND grade = '2024'`, [FIX.termId]);
  const backup = { min: rule.min_credit, max: rule.max_credit };
  await sql(`UPDATE t_credit_rule SET max_credit = 0 WHERE term_id = ? AND grade = '2024'`, [FIX.termId]);

  const offering = await createOffering('ZZC002', 40, [{ weekday: 5, startPeriod: 1, endPeriod: 2, parity: 0 }]);
  const res = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: offering, requestId: rid() } });

  const [off] = await sql(`SELECT enrolled FROM t_course_offering WHERE id = ?`, [offering]);
  await sql(`UPDATE t_credit_rule SET min_credit = ?, max_credit = ? WHERE term_id = ? AND grade = '2024'`, [
    backup.min,
    backup.max,
    FIX.termId,
  ]);
  assertCase(
    'TC-07',
    '选课后总学分超过上限',
    res && res.code === 2003 && Number(off.enrolled) === 0,
    `code=${res && res.code}，名额未被占用（enrolled=${off.enrolled}）`
  );
}

async function tc08() {
  // 学号 2024003（吴子墨）仅通过大学英语，未通过程序设计基础 → 数据结构需要先修
  const token = await login('2024003');
  const [off] = await sql(
    `SELECT o.id FROM t_course_offering o JOIN t_course c ON c.id = o.course_id
      WHERE c.course_code = 'CS2001' AND o.term_id = ? LIMIT 1`,
    [FIX.termId]
  );
  const res = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: off.id, requestId: rid() } });
  const missing = res && res.data && res.data.missing ? res.data.missing.map((m) => m.name).join('、') : '';
  assertCase('TC-08', '未通过先修课程', res && res.code === 2004 && !!missing, `code=${res && res.code}，缺失先修=${missing}`);
}

async function tc09() {
  const username = FIX.students[5].username;
  const token = await login(username);
  const all = await sql(`SELECT id, start_time, end_time FROM t_enroll_batch WHERE term_id = ?`, [FIX.termId]);
  await sql(`UPDATE t_enroll_batch SET start_time = DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE term_id = ?`, [FIX.termId]);

  const offering = await createOffering('ZZC003', 40, [{ weekday: 5, startPeriod: 3, endPeriod: 4, parity: 0 }]);
  const res = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: offering, requestId: rid() } });

  for (const b of all) {
    await sql(`UPDATE t_enroll_batch SET start_time = ?, end_time = ? WHERE id = ?`, [b.start_time, b.end_time, b.id]);
  }
  assertCase('TC-09', '不在本人批次时间窗口内选课', res && res.code === 2005, `code=${res && res.code}`);
}

async function tc10() {
  const a = FIX.students[6].username;
  const b = FIX.students[7].username;
  const tokenA = await login(a);
  const tokenB = await login(b);

  const offering = await createOffering('ZZC001', 1, [{ weekday: 6, startPeriod: 3, endPeriod: 4, parity: 0 }]);
  const rA = await apiCall('POST', '/api/enrollments', { token: tokenA, body: { offeringId: offering, requestId: rid() } });
  const rB1 = await apiCall('POST', '/api/enrollments', { token: tokenB, body: { offeringId: offering, requestId: rid() } });
  const rB2 = await apiCall('POST', '/api/waitlist', { token: tokenB, body: { offeringId: offering, requestId: rid() } });
  const rDrop = await apiCall('DELETE', `/api/enrollments/${offering}`, { token: tokenA, body: { requestId: rid() } });

  const [off] = await sql(`SELECT enrolled, capacity FROM t_course_offering WHERE id = ?`, [offering]);
  const enr = await sql(
    `SELECT COUNT(*) AS c FROM t_enrollment e JOIN t_student s ON s.id = e.student_id
      WHERE e.offering_id = ? AND e.status = 1 AND s.student_no = ?`,
    [offering, b]
  );
  const wl = await sql(
    `SELECT w.status, w.queue_no FROM t_waitlist w JOIN t_student s ON s.id = w.student_id
      WHERE w.offering_id = ? AND s.student_no = ?`,
    [offering, b]
  );
  const notice = await sql(`SELECT COUNT(*) AS c FROM t_notice WHERE related_id = ? AND type = 2`, [offering]);
  const promotedTrace = rDrop && rDrop.data && rDrop.data.promoted ? rDrop.data.promoted : [];

  assertCase(
    'TC-10',
    '满员课程加入候补后有人退课',
    rA.code === 0 &&
      rB1.code === 2001 &&
      rB2.code === 0 &&
      rDrop.code === 0 &&
      Number(enr[0].c) === 1 &&
      wl.length &&
      (wl[0].status === 2 || wl[0].status === 4) &&
      Number(notice[0].c) >= 1 &&
      Number(off.enrolled) === 1,
    `B 选课 ${rB1.code}，候补 ${rB2.code}，退课 ${rDrop.code}，递补后 enrolled=${off.enrolled}，B 的记录 ${enr[0].c} 条，候补状态 ${wl[0] && wl[0].status}，通知 ${notice[0].c} 条，递补轨迹 ${promotedTrace.length} 步`
  );
}

async function tc11() {
  const a = FIX.students[8].username;
  const b = FIX.students[9].username;
  const tokenA = await login(a);
  const tokenB = await login(b);

  const offering = await createOffering('ZZC002', 1, [{ weekday: 6, startPeriod: 5, endPeriod: 6, parity: 0 }]);
  await apiCall('POST', '/api/enrollments', { token: tokenA, body: { offeringId: offering, requestId: rid() } });
  const join = await apiCall('POST', '/api/waitlist', { token: tokenB, body: { offeringId: offering, requestId: rid() } });

  // B 在此之后选一门与目标开课冲突的课程，使递补校验失败
  const clash = await createOffering('ZZC003', 40, [{ weekday: 6, startPeriod: 5, endPeriod: 6, parity: 0 }]);
  const rClash = await apiCall('POST', '/api/enrollments', { token: tokenB, body: { offeringId: clash, requestId: rid() } });

  // 通过教务端扩大容量释放名额，触发递补
  const adminToken = await login('academic');
  const adj = await apiCall('PUT', `/api/admin/offerings/${offering}`, { token: adminToken, body: { capacity: 2 } });

  const wl = await sql(
    `SELECT w.status FROM t_waitlist w JOIN t_student s ON s.id = w.student_id
      WHERE w.offering_id = ? AND s.student_no = ?`,
    [offering, b]
  );
  const failNotice = await sql(`SELECT COUNT(*) AS c FROM t_notice WHERE related_id = ? AND type = 3`, [offering]);

  assertCase(
    'TC-11',
    '递补对象此时已产生时间冲突',
    join.code === 0 && rClash.code === 0 && adj.code === 0 && wl.length && wl[0].status === 4 && Number(failNotice[0].c) >= 1,
    `候补 ${join.code}，冲突课程 ${rClash.code}，容量调整 ${adj.code}，候补状态 ${wl[0] && wl[0].status}（4=已失效），递补失败通知 ${failNotice[0] && failNotice[0].c} 条`
  );
}

async function tc12() {
  const username = FIX.students[10].username;
  const token = await login(username);
  const source = await createOffering('ZZC001', 40, [{ weekday: 4, startPeriod: 1, endPeriod: 2, parity: 0 }]);
  const target = await createOffering('ZZC002', 1, [{ weekday: 4, startPeriod: 3, endPeriod: 4, parity: 0 }]);

  // 先占满目标课程
  const filler = await login(FIX.students[11].username);
  await apiCall('POST', '/api/enrollments', { token: filler, body: { offeringId: target, requestId: rid() } });
  const r1 = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: source, requestId: rid() } });

  const [before] = await sql(`SELECT enrolled FROM t_course_offering WHERE id = ?`, [source]);
  const beforeVal = Number(before.enrolled);
  const res = await apiCall('POST', '/api/enrollments/switch', {
    token,
    body: { fromOfferingId: source, toOfferingId: target, requestId: rid() },
  });
  const [after] = await sql(`SELECT enrolled FROM t_course_offering WHERE id = ?`, [source]);
  const [targetOff] = await sql(`SELECT enrolled, capacity FROM t_course_offering WHERE id = ?`, [target]);
  const stillIn = await sql(
    `SELECT COUNT(*) AS c FROM t_enrollment e JOIN t_student s ON s.id = e.student_id
      WHERE e.offering_id = ? AND e.status = 1 AND s.student_no = ?`,
    [source, username]
  );

  assertCase(
    'TC-12',
    '换课的目标课程已满',
    r1.code === 0 &&
      res.code === 2009 &&
      Number(after.enrolled) === beforeVal &&
      Number(stillIn[0].c) === 1 &&
      Number(targetOff.enrolled) <= Number(targetOff.capacity),
    `换课返回 ${res.code}，原课程 enrolled 保持 ${after.enrolled}，原课程记录 ${stillIn[0].c} 条`
  );
}

async function tc13() {
  const username = FIX.students[12].username;
  const token = await login(username);
  const offering = await createOffering('ZZC003', 40, [{ weekday: 4, startPeriod: 5, endPeriod: 6, parity: 0 }]);
  const r1 = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: offering, requestId: rid() } });

  const [batch] = await sql(`SELECT id, end_time FROM t_enroll_batch WHERE term_id = ? AND type = 2 LIMIT 1`, [FIX.termId]);
  await sql(`UPDATE t_enroll_batch SET end_time = DATE_SUB(NOW(), INTERVAL 30 DAY) WHERE id = ?`, [batch.id]);

  const [before] = await sql(`SELECT enrolled FROM t_course_offering WHERE id = ?`, [offering]);
  const res = await apiCall('DELETE', `/api/enrollments/${offering}`, { token, body: { requestId: rid() } });
  const [after] = await sql(`SELECT enrolled FROM t_course_offering WHERE id = ?`, [offering]);

  await sql(`UPDATE t_enroll_batch SET end_time = ? WHERE id = ?`, [batch.end_time, batch.id]);

  assertCase(
    'TC-13',
    '退课截止时间后发起退课',
    r1.code === 0 && res.code === 2008 && Number(after.enrolled) === Number(before.enrolled),
    `code=${res && res.code}，名额未释放（${before.enrolled} → ${after.enrolled}）`
  );
}

async function tc14() {
  const token = await login(FIX.students[13].username);
  const username = FIX.students[13].username;
  const res = await apiCall('GET', '/api/admin/dashboard', { token });
  const logs = await sql(
    `SELECT COUNT(*) AS c FROM t_audit_log WHERE action = 'FORBIDDEN_ACCESS' AND username = ?`,
    [username]
  );
  assertCase(
    'TC-14',
    '学生调用教务端接口',
    res.code === 1003 && Number(logs[0].c) >= 1,
    `code=${res.code}，审计日志 ${logs[0].c} 条`
  );
}

async function tc15() {
  const username = FIX.students[14].username;
  const token = await login(username);
  const offering = await createOffering('ZZC004', 60, [{ weekday: 2, startPeriod: 7, endPeriod: 8, parity: 0 }]);

  const codes = [];
  for (let i = 0; i < 15; i += 1) {
    // 使用同一开课连续提交：前若干次得到 2006（已选），之后应触发 9001
    const r = await apiCall('POST', '/api/enrollments', { token, body: { offeringId: offering, requestId: rid() } });
    codes.push(r.code);
  }
  const limited = codes.filter((c) => c === 9001).length;

  // 正常用户不受影响
  const normalToken = await login('2024002');
  const normal = await apiCall('GET', '/api/courses?size=1', { token: normalToken });

  assertCase(
    'TC-15',
    '60 秒内发起 15 次选课写请求',
    limited >= 1 && normal.code === 0,
    `触发限速 ${limited} 次（请求码序列 ${codes.join(',')}），其他用户读接口 ${normal.code}`
  );
  void codes;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log(`验收测试目标：${BASE}\n`);

  const health = await apiCall('GET', '/api/health');
  if (!health || health.code !== 0) {
    console.error('服务不可用，请先启动：npm start');
    process.exit(1);
  }

  conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    await setup();
    const cases = [tc01, tc02, tc03, tc04, tc05, tc06, tc07, tc08, tc09, tc10, tc11, tc12, tc13, tc14, tc15];
    for (const fn of cases) {
      try {
        await fn();
      } catch (e) {
        record('ERR', fn.name, false, '执行异常：' + e.message);
      }
    }
  } finally {
    try {
      await teardown();
    } catch (e) {
      console.error('清理测试数据失败：', e.message);
    }
    await conn.end();
  }

  console.log('验收用例结果：');
  results.forEach((r) => {
    console.log(`  ${r.pass ? '通过' : '失败'}  ${r.id}  ${r.name}`);
    console.log(`        ${r.detail}`);
  });
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n共 ${results.length} 条，通过 ${pass} 条，失败 ${results.length - pass} 条`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('验收测试异常：', e);
  process.exit(1);
});
