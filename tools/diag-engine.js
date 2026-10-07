'use strict';

/**
 * 静态版引擎诊断：打印学生、开课、排课、批次的关键状态，
 * 用于在编写回归测试前确认数据基线。
 */

// 目录结构重构后 mock 数据层由 web-build/mock/ 迁到 frontend/mock/
const E = require('../frontend/mock/index.js');

const q = (m, p, query, body, tk) => E.handle(m, p, query || {}, body || {}, tk || null);

async function login(username) {
  const r = await q('POST', '/api/auth/login', {}, { username, password: E.DEMO_SECRET });
  if (r.code !== 0) throw new Error(`登录失败 ${username}: ${r.code} ${r.message}`);
  return r.data.token;
}

async function main() {
  console.log('=== 路由总数 ===', E.ROUTES.length);

  const tk = await login('2024001');
  const term = (await q('GET', '/api/terms/current', {}, null, tk)).data.current;
  console.log('当前学期：', term.name, term.term_code);

  const mine = (await q('GET', '/api/enrollments/mine', {}, null, tk)).data;
  console.log(
    `\n学生 2024001 已选 ${mine.list.length} 门，总学分 ${mine.totalCredit}，上限 ${
      mine.creditRule && mine.creditRule.max_credit
    }`
  );
  mine.list.forEach((x) =>
    console.log(`  - ${x.course_code} ${x.course_name} ｜ ${x.scheduleText.join('；')} ｜ 教师 ${x.teacher_name}`)
  );

  const tt = (await q('GET', '/api/timetable', {}, null, tk)).data;
  console.log('课表单元格：', tt.cells.length, '冲突对：', tt.conflictCells.length);

  const courses = (await q('GET', '/api/courses', { page: 1, size: 50 }, null, tk)).data;
  console.log(`\n可选开课 ${courses.total} 门：`);
  const byStatus = {};
  courses.list.forEach((c) => {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  });
  console.log('  状态分布：', JSON.stringify(byStatus));
  courses.list.forEach((c) =>
    console.log(
      `  [${c.status}] ${c.courseCode} ${c.courseName} ${c.enrolled}/${c.capacity} 热度${c.heat} 余${c.remaining} ${
        c.selectable ? '可选' : c.reasons.map((r) => r.code).join(',')
      }`
    )
  );

  const wl = (await q('GET', '/api/waitlist/mine', {}, null, tk)).data;
  console.log(
    '\n候补：',
    wl.list.length,
    wl.list.map((x) => `${x.course_name} 第${x.queue_no}位 ${x.statusText}`).join('；')
  );

  const batches = (await q('GET', '/api/admin/batches', {}, null, await login('academic'))).data;
  console.log('\n批次：');
  batches.list.forEach((b) =>
    console.log(`  ${b.name} ${b.start_time} ~ ${b.end_time} => ${b.state} 年级=${b.target_grade || '不限'}`)
  );
}

main().catch((e) => {
  console.error('诊断失败：', e);
  process.exit(1);
});
