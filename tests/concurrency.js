'use strict';

/**
 * 并发一致性与幂等实测（面向 PostgreSQL + Spring Boot 后端）。
 *
 * 这是本作业「数据冲突要在数据库控制，事务，要考虑多人」这条要求最直接的验证：
 *
 *   场景 1 并发抢课：8 个学生同时抢一门容量只有 3 人的课。
 *           期望：恰好 3 人成功、5 人收到 2001（名额已满），
 *           并且数据库里 enrolled 严格等于 3、remaining 不为负、选课记录条数等于 3。
 *           实现依据：占名额走 `UPDATE ... SET enrolled = enrolled + 1
 *           WHERE id = ? AND enrolled < capacity AND status <> 0`，
 *           判断与自增在同一条语句里原子完成，靠行锁串行化。
 *
 *   场景 2 幂等：同一 requestId 重复提交选课。
 *           期望：第二次拿到与第一次完全一致的返回体，名额只被扣一次。
 *
 *   场景 3 候补递补：容量 1 的课被 A 占满 → B 加入候补 → A 退课。
 *           期望：名额自动递给 B（A 释放后 enrolled 仍为 1），B 的选课记录来源标记为候补递补。
 *
 * 用法：node tests/concurrency.js [baseUrl]
 *      默认 http://127.0.0.1:3000
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const ACADEMIC = { username: 'academic', secret: '123456' };
const STUDENTS = [
  '2023001', '2023002', '2023003', '2024001',
  '2024002', '2024003', '2025001', '2025002',
];

let seq = 0;
const rid = (tag) => `test-${tag}-${Date.now()}-${++seq}`;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => null);
}

async function login(username) {
  const r = await call('POST', '/api/auth/login', { body: { username, password: '123456' } });
  if (!r || r.code !== 0) throw new Error(`登录失败 ${username}: ${r && r.message}`);
  return r.data.token;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${ok ? '通过' : '失败'}  ${name}${detail === undefined ? '' : '  → ' + detail}`);
}

/**
 * 建一门容量为 capacity 的低学分新课（不排课 → 不会产生时间冲突）。
 *
 * 注意：教务端对「同一学期 + 同一课程 + 同一教师」有唯一约束，而种子数据里
 * 已经存在 16 门开课，所以不能只按「课程」挑，必须挑一个「课程 + 教师」组合
 * 在 existingPairs 里还不存在的。existingPairs 由 main() 依据
 * /api/admin/offerings 的返回构建，元素形如 `${course_id}|${teacher_id}`。
 */
async function createOffering(token, courses, teachers, capacity, usedCourseIds, existingPairs) {
  for (const course of courses) {
    if (Number(course.credit) > 2 || usedCourseIds.has(Number(course.id)) || course.prereq_count) {
      continue;
    }
    for (const teacher of teachers) {
      const key = course.id + '|' + teacher.id;
      if (existingPairs.has(key)) continue;
      const r = await call('POST', '/api/admin/offerings', {
        token,
        body: {
          courseId: Number(course.id),
          teacherId: Number(teacher.id),
          capacity,
          campus: '并发测试校区',
          remark: '并发一致性实测自动创建',
        },
      });
      if (!r || r.code !== 0) throw new Error(`创建开课失败：${r && r.message}`);
      usedCourseIds.add(Number(course.id));
      existingPairs.add(key);
      return { offeringId: r.data.offeringId, courseName: course.name };
    }
  }
  throw new Error('找不到可用于测试的「低学分课程 + 教师」组合');
}

async function offeringOf(token, offeringId) {
  const r = await call('GET', '/api/admin/offerings', { token });
  if (!r || r.code !== 0) throw new Error('查询开课失败');
  // 教务端开课列表用的是数据库列名（snake_case），与前端 admin.js 的取值方式一致
  const row = r.data.list.find((x) => Number(x.offering_id) === Number(offeringId));
  if (!row) throw new Error(`教务开课列表中找不到 offeringId=${offeringId}`);
  return row;
}

async function main() {
  console.log(`并发与幂等测试目标：${BASE}\n`);

  const health = await call('GET', '/api/health');
  if (!health || health.code !== 0) {
    console.error('后端未就绪，请先启动服务');
    process.exit(1);
  }

  const academicToken = await login(ACADEMIC.username);
  const room = await call('GET', '/api/admin/offerings', { token: academicToken });
  const courses = room.data.courses;
  const teachers = room.data.teachers;
  const usedCourseIds = new Set([4, 5, 6, 16]);
  // 教务端对 (course_id, teacher_id) 在同学期内唯一，先把已有组合收进排除集
  const existingPairs = new Set((room.data.list || []).map((x) => `${x.course_id}|${x.teacher_id}`));

  /* ---------------- 场景 1：并发抢课 ---------------- */
  console.log('场景 1：8 人并发抢 3 个名额');
  const CAPACITY = 3;
  const s1 = await createOffering(academicToken, courses, teachers, CAPACITY, usedCourseIds, existingPairs);

  const tokens = await Promise.all(STUDENTS.map((u) => login(u)));

  const responses = await Promise.all(
    tokens.map((token, i) =>
      call('POST', '/api/enrollments', {
        token,
        body: { offeringId: s1.offeringId, requestId: rid(`s1-${i}`) },
      })
    )
  );

  const success = responses.filter((r) => r && r.code === 0).length;
  const full = responses.filter((r) => r && r.code === 2001).length;
  const other = responses.filter((r) => r && r.code !== 0 && r.code !== 2001);
  const codes = responses.map((r) => (r ? r.code : 'null')).join(',');

  check('成功人数恰好等于容量 3', success === CAPACITY, `成功 ${success} 人（codes=${codes}）`);
  check('其余请求被容量拦截为 2001', full === STUDENTS.length - CAPACITY, `2001 共 ${full} 条`);
  check('没有其他异常错误码', other.length === 0,
    other.length ? other.map((r) => `${r.code}:${r.message}`).join(' | ') : '无');

  const after1 = await offeringOf(academicToken, s1.offeringId);
  check('数据库 enrolled 严格等于 3（未超卖）', Number(after1.enrolled) === CAPACITY,
    `enrolled=${after1.enrolled} capacity=${after1.capacity}`);
  check('remaining 不为负', Number(after1.remaining) >= 0, `remaining=${after1.remaining}`);
  check('选课记录条数与 enrolled 一致', Number(after1.enrolledCount) === Number(after1.enrolled),
    `记录 ${after1.enrolledCount} 条 / enrolled=${after1.enrolled}`);

  /* ---------------- 场景 2：幂等重复提交 ---------------- */
  console.log('\n场景 2：同一 requestId 重复提交选课');
  const s2 = await createOffering(academicToken, courses, teachers, 1, usedCourseIds, existingPairs);
  const sameRid = rid('s2-idem');
  const tokenA = tokens[0];

  const first = await call('POST', '/api/enrollments', {
    token: tokenA, body: { offeringId: s2.offeringId, requestId: sameRid },
  });
  const second = await call('POST', '/api/enrollments', {
    token: tokenA, body: { offeringId: s2.offeringId, requestId: sameRid },
  });
  const after2 = await offeringOf(academicToken, s2.offeringId);

  check('首次提交成功', first && first.code === 0, `code=${first && first.code}`);
  check('重复提交返回与首次一致的返回体',
    second && second.code === first.code && second.message === first.message,
    `第二次 code=${second && second.code}`);
  check('重复提交未重复扣减名额', Number(after2.enrolled) === 1, `enrolled=${after2.enrolled}`);
  check('重复提交未产生重复选课记录',
    Number(after2.enrolledCount) === 1, `记录 ${after2.enrolledCount} 条`);

  /* ---------------- 场景 3：候补自动递补 ---------------- */
  console.log('\n场景 3：退课后名额自动递补给候补第一位');
  const s3 = await createOffering(academicToken, courses, teachers, 1, usedCourseIds, existingPairs);
  const studentA = tokens[1];
  const studentB = tokens[2];
  const userB = STUDENTS[2];

  // A 占满唯一名额
  const aEnroll = await call('POST', '/api/enrollments', {
    token: studentA, body: { offeringId: s3.offeringId, requestId: rid('s3-a') },
  });
  // B 加入候补
  const bWait = await call('POST', '/api/waitlist', {
    token: studentB, body: { offeringId: s3.offeringId, requestId: rid('s3-b') },
  });
  check('A 抢占唯一名额成功', aEnroll && aEnroll.code === 0, `code=${aEnroll && aEnroll.code}`);
  check('B 加入候补成功且排位为第 1 位',
    bWait && bWait.code === 0 && Number(bWait.data.queueNo) === 1,
    `code=${bWait && bWait.code}，排位 ${bWait && bWait.data && bWait.data.queueNo}`);

  // A 退课 → 触发递补
  const aDrop = await call('DELETE', `/api/enrollments/${s3.offeringId}?requestId=${rid('s3-drop')}`, {
    token: studentA,
  });
  const promoted = aDrop && aDrop.data && aDrop.data.promoted ? aDrop.data.promoted : [];
  check('退课返回中带有递补记录', promoted.length > 0,
    promoted.length ? `递补动作 ${promoted.map((p) => p.action).join(',')}` : '无递补记录');
  check('递补动作为 PROMOTED',
    promoted.some((p) => p.action === 'PROMOTED'),
    promoted.map((p) => `${p.action}${p.reason ? '(' + p.reason + ')' : ''}`).join(',') || '无');

  const after3 = await offeringOf(academicToken, s3.offeringId);
  check('名额被 B 接手（enrolled 仍为 1，未凭空少一个）', Number(after3.enrolled) === 1,
    `enrolled=${after3.enrolled}`);

  const bMine = await call('GET', '/api/waitlist/mine', { token: studentB });
  const bRow = bMine && bMine.data ? bMine.data.list.find(
    (x) => Number(x.offering_id) === Number(s3.offeringId)) : null;
  check('B 的候补状态变为「已递补」', bRow && Number(bRow.status) === 2,
    bRow ? `status=${bRow.status} ${bRow.status_text || bRow.statusText || ''}` : '未找到候选记录');

  const bEnrollments = await call('GET', '/api/enrollments/mine', { token: studentB });
  const bHas = bEnrollments && bEnrollments.data
    ? bEnrollments.data.list.some((x) => Number(x.offering_id) === Number(s3.offeringId)) : false;
  check(`B(${userB}) 的已选列表中出现该课程`, bHas, bHas ? '已生成选课记录' : '未生成');

  /* ---------------- 汇总 ---------------- */
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n共 ${results.length} 项，通过 ${pass} 项，失败 ${results.length - pass} 项`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('并发测试异常：', e.message);
  process.exit(1);
});
