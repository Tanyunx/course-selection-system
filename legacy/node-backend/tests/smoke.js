'use strict';

/**
 * 接口冒烟测试：覆盖核心流程，输出仅包含状态码与业务结果。
 * 用法：node tests/smoke.js [baseUrl]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

/** 演示账号（与 db/seed.sql 一致） */
const ACCOUNTS = {
  student: { username: '2024001', secret: '123456' },
  student2: { username: '2024002', secret: '123456' },
  teacher: { username: 'teacher001', secret: '123456' },
  academic: { username: 'academic', secret: '123456' },
  sysadmin: { username: 'sysadmin', secret: '123456' },
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return json;
}

async function login(key) {
  const acc = ACCOUNTS[key];
  const r = await call('POST', '/api/auth/login', { body: { username: acc.username, password: acc.secret } });
  if (!r || r.code !== 0) throw new Error(`登录失败 ${key}: ${r && r.message}`);
  return r.data.token;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
}

async function main() {
  console.log(`冒烟测试目标：${BASE}\n`);

  // 健康检查
  const health = await call('GET', '/api/health');
  check('健康检查 /api/health', health && health.code === 0 && health.data.status === 'UP', health && health.data.status);

  // 未登录拦截
  const noAuth = await call('GET', '/api/courses');
  check('未登录访问返回 1002', noAuth && noAuth.code === 1002, `code=${noAuth && noAuth.code}`);

  const token = await login('student');
  const teacherToken = await login('teacher');
  const academicToken = await login('academic');
  const sysToken = await login('sysadmin');

  const me = await call('GET', '/api/auth/me', { token });
  check('当前用户信息 /api/auth/me', me && me.code === 0 && me.data.profile.role === 1, me && me.data.profile.realName);

  const term = await call('GET', '/api/terms/current', { token });
  check('当前学期 /api/terms/current', term && term.code === 0 && term.data.current, term && term.data.current.term_code);

  const courses = await call('GET', '/api/courses?page=1&size=5', { token });
  check(
    '课程列表 /api/courses',
    courses && courses.code === 0 && courses.data.list.length > 0,
    courses && `${courses.data.total} 门开课，首条状态 ${courses.data.list[0].status}`
  );

  const filtered = await call('GET', '/api/courses?available=true&size=50', { token });
  check('仅看可选筛选', filtered && filtered.code === 0, filtered && `${filtered.data.total} 条`);

  const mine = await call('GET', '/api/enrollments/mine', { token });
  check(
    '我的已选 /api/enrollments/mine',
    mine && mine.code === 0,
    mine && `${mine.data.list.length} 门，共 ${mine.data.totalCredit} 学分，上限 ${mine.data.creditRule && mine.data.creditRule.max_credit}`
  );

  const tt = await call('GET', '/api/timetable', { token });
  check('我的课表 /api/timetable', tt && tt.code === 0, tt && `${tt.data.cells.length} 个时段`);

  const wait = await call('GET', '/api/waitlist/mine', { token });
  check('我的候补 /api/waitlist/mine', wait && wait.code === 0, wait && `${wait.data.list.length} 条`);

  const notices = await call('GET', '/api/notices', { token });
  check('通知列表 /api/notices', notices && notices.code === 0, notices && `${notices.data.total} 条，未读 ${notices.data.unread}`);

  const teacherOfferings = await call('GET', '/api/teacher/offerings', { token: teacherToken });
  check('教师我的开课', teacherOfferings && teacherOfferings.code === 0, teacherOfferings && `${teacherOfferings.data.list.length} 门`);

  const adminDash = await call('GET', '/api/admin/dashboard', { token: academicToken });
  check('教务概览', adminDash && adminDash.code === 0, adminDash && `开课 ${adminDash.data.offeringCount}，利用率 ${adminDash.data.utilization}%`);

  const adminOfferings = await call('GET', '/api/admin/offerings', { token: academicToken });
  check('教务开课计划', adminOfferings && adminOfferings.code === 0, adminOfferings && `${adminOfferings.data.list.length} 条`);

  const batches = await call('GET', '/api/admin/batches', { token: academicToken });
  check('选课批次', batches && batches.code === 0, batches && `${batches.data.list.length} 个批次`);

  const users = await call('GET', '/api/admin/users', { token: sysToken });
  check('系统用户管理', users && users.code === 0, users && `${users.data.total} 个用户`);

  const monitor = await call('GET', '/api/admin/monitor', { token: sysToken });
  check('运行监控', monitor && monitor.code === 0, monitor && `成功率 ${monitor.data.successRate}%，在线 ${monitor.data.onlineUsers}`);

  const logs = await call('GET', '/api/admin/audit-logs?size=5', { token: sysToken });
  check('审计日志', logs && logs.code === 0, logs && `${logs.data.total} 条`);

  // 越权：学生调用教务接口
  const forbidden = await call('GET', '/api/admin/dashboard', { token });
  check('学生访问教务接口返回 1003', forbidden && forbidden.code === 1003, `code=${forbidden && forbidden.code}`);

  // 越权：教师调用选课接口
  const forbidden2 = await call('POST', '/api/enrollments', { token: teacherToken, body: { offeringId: 1 } });
  check('教师调用选课接口返回 1003', forbidden2 && forbidden2.code === 1003, `code=${forbidden2 && forbidden2.code}`);

  console.log('测试结果：');
  let pass = 0;
  results.forEach((r) => {
    console.log(`  ${r.pass ? '通过' : '失败'}  ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
    if (r.pass) pass += 1;
  });
  console.log(`\n共 ${results.length} 项，通过 ${pass} 项，失败 ${results.length - pass} 项`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟测试异常：', e.message);
  process.exit(1);
});
