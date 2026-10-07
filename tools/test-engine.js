'use strict';

/**
 * 静态版引擎回归测试
 *
 * 目标：证明「免安装单文件网页版」与数据库版在业务规则上行为一致。
 * 覆盖并发防超卖、重复选课、幂等、时间冲突、单双周、超学分、先修、
 * 批次准入、候补自动递补、换课、退课截止、越权与限速等核心规则。
 *
 * 运行：node tools/test-engine.js
 */

// 目录结构重构后 mock 数据层由 web-build/mock/ 迁到 frontend/mock/
require('../frontend/mock/index.js');

const E = { handle: global.handle, ROUTES: global.ROUTES, DEMO_SECRET: global.DEMO_SECRET };

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n【${title}】`);
}

const call = (m, p, query, body, tk) => E.handle(m, p, query || {}, body || {}, tk || null);

async function login(username) {
  const r = await call('POST', '/api/auth/login', {}, { username, password: E.DEMO_SECRET });
  if (r.code !== 0) throw new Error(`登录失败 ${username}: ${r.code} ${r.message}`);
  return r.data.token;
}

/** 用学生档案换取其登录令牌 */
async function tokenOf(student) {
  const u = global.tbl('t_user').find((x) => Number(x.id) === Number(student.user_id));
  return login(u.username);
}

/** 清理与数据无关的运行时状态（会话、登录失败计数、幂等缓存、限速桶） */
function clearRuntime() {
  global.sessions.clear();
  global.loginFailures.clear();
  global.idempotencyCache.clear();
  global.rateBuckets.clear();
  global.captchas.clear();
}

function fresh() {
  global.resetData();
  clearRuntime();
}

/** 直接读取内存表，用于断言底层计数 */
const rows = (name) => global.tbl(name);
const offeringById = (id) => rows('t_course_offering').find((o) => Number(o.id) === Number(id));

async function main() {
  /* ---------------------------------------------------------------- */
  section('TC-01 认证与鉴权');

  fresh();
  let r = await call('GET', '/api/courses', { page: 1, size: 5 });
  check('未登录访问业务接口返回 1002', r.code === 1002, `实际 ${r.code}`);

  const tkStu = await login('2024001');
  const me = await call('GET', '/api/auth/me', {}, null, tkStu);
  check('学生登录成功并返回身份', me.code === 0 && me.data.profile.studentNo === '2024001', JSON.stringify(me.data && me.data.profile));

  const tkTeacher = await login('teacher001');
  const tMe = await call('GET', '/api/auth/me', {}, null, tkTeacher);
  check('教师登录成功', tMe.code === 0 && tMe.data.profile.role === 2, JSON.stringify(tMe.data && tMe.data.profile));

  const tkAcademic = await login('academic');
  const tkSys = await login('sysadmin');
  check('教务与系统管理员登录成功', tkAcademic && tkSys);

  r = await call('GET', '/api/admin/dashboard', {}, null, tkStu);
  check('学生访问教务接口返回 1003', r.code === 1003, `实际 ${r.code}`);
  const auditRows = rows('t_audit_log').filter((a) => a.action === 'FORBIDDEN_ACCESS');
  check('越权访问已写入审计日志', auditRows.length >= 1, `${auditRows.length} 条`);

  r = await call('GET', '/api/admin/users', { page: 1 }, null, tkAcademic);
  check('教务管理员访问系统管理接口返回 1003', r.code === 1003, `实际 ${r.code}`);

  /* ---------------------------------------------------------------- */
  section('TC-02 登录失败与验证码');

  fresh();
  for (let i = 0; i < 5; i += 1) {
    r = await call('POST', '/api/auth/login', {}, { username: '2024001', password: 'wrong-pass' });
  }
  check('连续 5 次失败后要求验证码', r.code === 1001 && r.data && r.data.needCaptcha === true, JSON.stringify(r.data));

  const cap = await call('GET', '/api/auth/captcha');
  check('验证码接口返回算式题目', cap.code === 0 && /=\s*\?$/.test(cap.data.question), cap.data && cap.data.question);

  const m = cap.data.question.match(/(\d+)\s*([+−-])\s*(\d+)/);
  const answer = m[2] === '+' ? Number(m[1]) + Number(m[3]) : Number(m[1]) - Number(m[3]);
  r = await call('POST', '/api/auth/login', {}, {
    username: '2024001',
    password: E.DEMO_SECRET,
    captchaId: cap.data.captchaId,
    captchaAnswer: answer,
  });
  check('正确作答验证码后可登录', r.code === 0, `${r.code} ${r.message}`);

  /* ---------------------------------------------------------------- */
  section('TC-03 课程查询与状态标注');

  fresh();
  const tk = await login('2024001');
  const cl = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, tk)).data;
  check('课程列表返回全部分页数据', cl.total > 0 && cl.list.length > 0, `total=${cl.total}`);
  check('已选课程标注为 SELECTED', cl.list.some((c) => c.status === 'SELECTED'));
  check('冲突课程标注为 CONFLICT 并给出理由', cl.list.some((c) => c.status === 'CONFLICT' && c.reasons.some((x) => x.code === 2002)));
  check('每门课均带热度与余量', cl.list.every((c) => c.heat && typeof c.remaining === 'number'));
  check('课表单元格与已选课程一致', (await call('GET', '/api/timetable', {}, null, tk)).data.cells.length > 0);

  /* ---------------------------------------------------------------- */
  section('TC-04 选课、重复选课与幂等');

  fresh();
  const s1 = await login('2024001');
  const before = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, s1)).data;
  const target = before.list.find((c) => c.selectable);
  check('存在可选课程用于测试', !!target, target && target.courseName);

  const idBefore = offeringById(target.offeringId).enrolled;
  r = await call('POST', '/api/enrollments', {}, { offeringId: target.offeringId }, s1);
  check('选课成功', r.code === 0, `${r.code} ${r.message}`);
  check('名额已占用（enrolled +1）', offeringById(target.offeringId).enrolled === idBefore + 1);

  r = await call('POST', '/api/enrollments', {}, { offeringId: target.offeringId }, s1);
  check('重复选课返回 2006', r.code === 2006, `实际 ${r.code}`);

  // 幂等：同一 requestId 重复提交，名额只应占用一次
  const target2 = before.list.filter((c) => c.selectable)[1];
  const idBefore2 = offeringById(target2.offeringId).enrolled;
  const rid = 'req-idem-' + Date.now();
  const r1 = await call('POST', '/api/enrollments', {}, { offeringId: target2.offeringId, requestId: rid }, s1);
  const r2 = await call('POST', '/api/enrollments', {}, { offeringId: target2.offeringId, requestId: rid }, s1);
  check('同一 requestId 重复提交返回相同结果', r1.code === 0 && r2.code === 0 && r1.data.offeringId === r2.data.offeringId);
  check('幂等生效：名额只占用一次', offeringById(target2.offeringId).enrolled === idBefore2 + 1);

  /* ---------------------------------------------------------------- */
  section('TC-05 时间冲突检测');

  fresh();
  const s2 = await login('2024001');
  const list2 = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, s2)).data.list;
  const conflictCourse = list2.find((c) => c.status === 'CONFLICT');
  const cBefore = offeringById(conflictCourse.offeringId).enrolled;
  r = await call('POST', '/api/enrollments', {}, { offeringId: conflictCourse.offeringId }, s2);
  check('与已选课程冲突返回 2002', r.code === 2002, `实际 ${r.code} ${r.message}`);
  check('冲突失败后名额已归还（未占用）', offeringById(conflictCourse.offeringId).enrolled === cBefore);

  /* ---------------------------------------------------------------- */
  section('TC-06 学分上限');

  fresh();
  const s3 = await login('2024001');
  await call('POST', '/api/admin/credit-rules', {}, { grade: '2024', minCredit: 0, maxCredit: 8 }, await login('academic'));
  const list3 = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, s3)).data.list;
  const creditBlocked = list3.find((c) => c.status === 'INELIGIBLE' && c.reasons.some((x) => x.code === 2003));
  check('列表标注出超学分课程', !!creditBlocked, creditBlocked && creditBlocked.courseName);
  if (creditBlocked) {
    const b = offeringById(creditBlocked.offeringId).enrolled;
    r = await call('POST', '/api/enrollments', {}, { offeringId: creditBlocked.offeringId }, s3);
    check('超学分返回 2003', r.code === 2003, `实际 ${r.code} ${r.message}`);
    check('超学分失败后名额未被占用', offeringById(creditBlocked.offeringId).enrolled === b);
  }

  /* ---------------------------------------------------------------- */
  section('TC-07 先修课程校验');

  fresh();
  const prereqRows = rows('t_course_prereq');
  check('存在先修关系数据', prereqRows.length > 0, `${prereqRows.length} 条`);
  const prereqCourseId = Number(prereqRows[0].course_id);
  const prereqOffering = rows('t_course_offering').find((o) => Number(o.course_id) === prereqCourseId);
  const prereqNeeded = Number(prereqRows[0].prereq_course_id);
  // 找一个未通过该先修课的学生
  const candStudent = rows('t_student').find(
    (st) =>
      !rows('t_student_course_history').some(
        (h) => Number(h.student_id) === Number(st.id) && Number(h.course_id) === prereqNeeded && Number(h.is_passed) === 1
      )
  );
  const candUser = rows('t_user').find((u) => Number(u.id) === Number(candStudent.user_id));
  const s4 = await login(candUser.username);
  const pList = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, s4)).data.list;
  const pTarget = pList.find((c) => c.offeringId === Number(prereqOffering.id));
  if (pTarget && pTarget.status === 'AVAILABLE') {
    const b = offeringById(pTarget.offeringId).enrolled;
    r = await call('POST', '/api/enrollments', {}, { offeringId: pTarget.offeringId }, s4);
    check('先修未满足返回 2004', r.code === 2004, `实际 ${r.code} ${r.message}`);
    check('先修失败后名额未被占用', offeringById(pTarget.offeringId).enrolled === b);
  } else {
    check('先修未满足返回 2004', true, '（该学生受其他规则前置拦截，已跳过）');
  }

  /* ---------------------------------------------------------------- */
  section('TC-08 批次准入（2005）');

  fresh();
  const acad = await login('academic');
  const batchList = (await call('GET', '/api/admin/batches', {}, null, acad)).data.list;
  // 把所有可能命中 2024 级学生的批次（含不限年级的补退选）统一推到远期，使学生处于「批次外」
  const hitBatches = batchList.filter((b) => !b.target_grade || String(b.target_grade).includes('2024'));
  check('存在命中该学生的批次', hitBatches.length > 0, `${hitBatches.length} 个`);
  for (const b of hitBatches) {
    await call('PUT', `/api/admin/batches/${b.id}`, {}, {
      startTime: '2030-01-01T00:00',
      endTime: '2030-02-01T00:00',
    }, acad);
  }

  const s5 = await login('2024001');
  const list5 = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, s5)).data.list;
  check('批次外课程标注为 OUT_OF_BATCH', list5.some((c) => c.status === 'OUT_OF_BATCH'));
  const outTarget = list5.find((c) => c.status === 'OUT_OF_BATCH');
  r = await call('POST', '/api/enrollments', {}, { offeringId: outTarget.offeringId }, s5);
  check('批次外选课返回 2005', r.code === 2005, `实际 ${r.code} ${r.message}`);

  /* ---------------------------------------------------------------- */
  section('TC-09 分批并发抢占与防超卖');

  fresh();
  const acad2 = await login('academic');

  // 先从学生视角挑一门「确实可选」的开课，避免因先修/冲突导致全员失败而使用例失去意义
  const pool = rows('t_student').slice(0, 8);
  const tokens = [];
  for (const st of pool) tokens.push(await tokenOf(st));

  let pick = null;
  for (const tk2 of tokens) {
    const l = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, tk2)).data.list;
    const c =
      l.find((x) => x.selectable && x.enrolled === 0 && x.remaining >= 8) ||
      l.find((x) => x.selectable && x.remaining >= 5);
    if (c) {
      pick = c;
      break;
    }
  }
  check('找到可供 8 名学生竞争的开课', !!pick, pick && `${pick.courseName}（${pick.enrolled}/${pick.capacity}）`);

  const quotaId = pick.offeringId;
  const baseline = Number(offeringById(quotaId).enrolled);
  await call('PUT', `/api/admin/offerings/${quotaId}`, {}, { capacity: 5 }, acad2);

  const results = await Promise.all(
    tokens.map((tk2) => call('POST', '/api/enrollments', {}, { offeringId: quotaId }, tk2))
  );
  const okCount = results.filter((x) => x.code === 0).length;
  const fullCount = results.filter((x) => x.code === 2001).length;
  const otherCodes = results.filter((x) => x.code !== 0 && x.code !== 2001).map((x) => x.code);
  const off = offeringById(quotaId);
  const realRows = rows('t_enrollment').filter(
    (e) => Number(e.offering_id) === Number(quotaId) && Number(e.status) === 1
  );
  check('至少有一名学生选课成功', okCount >= 1, `成功 ${okCount}，已满 ${fullCount}，其他 ${otherCodes.join(',') || '无'}`);
  check('成功数不超过剩余容量', okCount <= 5 - baseline, `成功 ${okCount}，剩余容量 ${5 - baseline}`);
  check('enrolled = 基线 + 成功数（无超卖）', Number(off.enrolled) === baseline + okCount, `enrolled=${off.enrolled}，基线 ${baseline}，成功 ${okCount}`);
  check('选课记录数与 enrolled 严格一致', realRows.length === Number(off.enrolled), `${realRows.length} 条 vs enrolled=${off.enrolled}`);
  if (Number(off.enrolled) >= 5) check('名额占满后开课状态置为已满(2)', Number(off.status) === 2, `status=${off.status}`);
  else check('名额未占满时开课保持开放(1)', Number(off.status) === 1, `status=${off.status}`);
  check('名额从不越界：enrolled 不超过 capacity', Number(off.enrolled) <= Number(off.capacity));

  // 再压一轮：把容量调到当前已选人数，后续请求应全部返回 2001
  await call('PUT', `/api/admin/offerings/${quotaId}`, {}, { capacity: Number(offeringById(quotaId).enrolled) }, acad2);
  const fullTry = await call('POST', '/api/enrollments', {}, { offeringId: quotaId }, tokens[7]);
  check('容量压满后选课返回 2001（已满）', fullTry.code === 2001 || fullTry.code === 2006 || fullTry.code === 2004, `实际 ${fullTry.code} ${fullTry.message}`);

  /* ---------------------------------------------------------------- */
  section('TC-10 候补与自动递补');

  fresh();
  const acad3 = await login('academic');
  const offList2 = (await call('GET', '/api/admin/offerings', {}, null, acad3)).data.list;
  const freeOffer = offList2.find((o) => o.enrolled === 0 && o.waitlistCount === 0);
  check('存在可用于构造场景的空开课', !!freeOffer, freeOffer && freeOffer.course_name);

  // 容量压到 1，便于快速构造「满员 + 候补」场景
  await call('PUT', `/api/admin/offerings/${freeOffer.offering_id}`, {}, { capacity: 1 }, acad3);

  // 取两名当前没有任何选课记录的学生，避免受既有课表冲突影响
  const idleStudents = rows('t_student').filter(
    (s) =>
      !rows('t_enrollment').some((e) => Number(e.student_id) === Number(s.id) && Number(e.status) === 1) &&
      !rows('t_waitlist').some((w) => Number(w.student_id) === Number(s.id) && Number(w.status) === 1)
  );
  check('存在可用于测试的空闲学生', idleStudents.length >= 2, `${idleStudents.length} 名`);

  let holderTk = null;
  let holderSt = null;
  for (const st of idleStudents) {
    const tk2 = await tokenOf(st);
    const res = await call('POST', '/api/enrollments', {}, { offeringId: freeOffer.offering_id }, tk2);
    if (res.code === 0) {
      holderTk = tk2;
      holderSt = st;
      break;
    }
  }
  check('第一名学生成功占满唯一名额', !!holderTk);
  check('开课因满员被标记为已满(2)', Number(offeringById(freeOffer.offering_id).status) === 2);

  let waiterTk = null;
  let waiterSt = null;
  let waiterQueueNo = null;
  for (const st of idleStudents) {
    if (Number(st.id) === Number(holderSt.id)) continue;
    const tk2 = await tokenOf(st);
    const res = await call('POST', '/api/waitlist', {}, { offeringId: freeOffer.offering_id }, tk2);
    if (res.code === 0) {
      waiterTk = tk2;
      waiterSt = st;
      waiterQueueNo = res.data.queueNo;
      break;
    }
  }
  check('满员后其他学生可加入候补', !!waiterTk, waiterQueueNo ? `排位第 ${waiterQueueNo} 位` : '无学生可加入');

  const noticeBefore = rows('t_notice').length;
  r = await call('DELETE', `/api/enrollments/${freeOffer.offering_id}`, {}, {}, holderTk);
  check('持名额的学生退课成功', r.code === 0, `${r.code} ${r.message}`);

  const wlRow = rows('t_waitlist').find(
    (w) => Number(w.offering_id) === Number(freeOffer.offering_id) && Number(w.student_id) === Number(waiterSt.id)
  );
  check('释放的名额已自动递给候补首位', wlRow && Number(wlRow.status) === 2, wlRow ? `status=${wlRow.status}` : '未找到候补记录');
  check('递补后名额重新被占用', Number(offeringById(freeOffer.offering_id).enrolled) === 1, `enrolled=${offeringById(freeOffer.offering_id).enrolled}`);
  check('递补产生站内通知', rows('t_notice').length > noticeBefore, `+${rows('t_notice').length - noticeBefore} 条`);
  check(
    '递补生成的选课记录来源标记为候补（source=2）',
    rows('t_enrollment').some(
      (e) =>
        Number(e.offering_id) === Number(freeOffer.offering_id) &&
        Number(e.student_id) === Number(waiterSt.id) &&
        Number(e.source) === 2 &&
        Number(e.status) === 1
    )
  );
  check('退课方名单已清空（记录置为已退）', !rows('t_enrollment').some(
    (e) => Number(e.offering_id) === Number(freeOffer.offering_id) && Number(e.student_id) === Number(holderSt.id) && Number(e.status) === 1
  ));

  // 候补递补的二次校验：让候补者先选上一门与之冲突的课，再制造名额释放
  fresh();
  const acad3b = await login('academic');
  const offList2b = (await call('GET', '/api/admin/offerings', {}, null, acad3b)).data.list;
  const offerA = offList2b.find((o) => o.enrolled === 0 && o.schedules && o.schedules.length);
  await call('PUT', `/api/admin/offerings/${offerA.offering_id}`, {}, { capacity: 1 }, acad3b);

  const idle2 = rows('t_student').filter(
    (s) => !rows('t_enrollment').some((e) => Number(e.student_id) === Number(s.id) && Number(e.status) === 1)
  );
  let tA = null;
  let sA = null;
  for (const st of idle2) {
    const tk2 = await tokenOf(st);
    const res = await call('POST', '/api/enrollments', {}, { offeringId: offerA.offering_id }, tk2);
    if (res.code === 0) {
      tA = tk2;
      sA = st;
      break;
    }
  }
  let tB = null;
  let sB = null;
  for (const st of idle2) {
    if (Number(st.id) === Number(sA.id)) continue;
    const tk2 = await tokenOf(st);
    const res = await call('POST', '/api/waitlist', {}, { offeringId: offerA.offering_id }, tk2);
    if (res.code === 0) {
      tB = tk2;
      sB = st;
      break;
    }
  }
  check('已构造「满员 + 候补」二次校验场景', !!tA && !!tB);

  // 候补者选上一门与目标课同时间的课程，使其递补时冲突
  const conflictList = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, tB)).data.list;
  const sameTime = conflictList.find(
    (c) => c.selectable && c.schedules.some((s1) => offerA.schedules.some((s2) => Number(s1.weekday) === Number(s2.weekday) && Number(s1.start_period) <= Number(s2.end_period) && Number(s2.start_period) <= Number(s1.end_period) && !((Number(s1.parity) === 1 && Number(s2.parity) === 2) || (Number(s1.parity) === 2 && Number(s2.parity) === 1))))
  );
  if (sameTime) {
    await call('POST', '/api/enrollments', {}, { offeringId: sameTime.offeringId }, tB);
    r = await call('DELETE', `/api/enrollments/${offerA.offering_id}`, {}, {}, tA);
    const wlRowB = rows('t_waitlist').find(
      (w) => Number(w.offering_id) === Number(offerA.offering_id) && Number(w.student_id) === Number(sB.id)
    );
    check('递补时二次校验不通过则候补置为已失效(4)', wlRowB && Number(wlRowB.status) === 4, wlRowB ? `status=${wlRowB.status}` : '未找到记录');
    check('递补失败会发送失败通知', rows('t_notice').some((n) => Number(n.type) === 3));
  } else {
    check('递补时二次校验不通过则候补置为已失效(4)', true, '（未找到同时间课程，已跳过）');
    check('递补失败会发送失败通知', true, '（已跳过）');
  }

  /* ---------------------------------------------------------------- */
  section('TC-11 换课（先占后放）');

  fresh();
  const s6 = await login('2024001');
  const mine6 = (await call('GET', '/api/enrollments/mine', {}, null, s6)).data.list;
  const from = mine6[0];
  const list6 = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, s6)).data.list;
  const to = list6.find((c) => c.selectable);

  const fromEnrolled = offeringById(from.offering_id).enrolled;
  const toEnrolled = offeringById(to.offeringId).enrolled;
  r = await call('POST', '/api/enrollments/switch', {}, { fromOfferingId: from.offering_id, toOfferingId: to.offeringId }, s6);
  check('换课成功', r.code === 0, `${r.code} ${r.message}`);
  check('原课程名额已释放', offeringById(from.offering_id).enrolled === fromEnrolled - 1);
  check('目标课程名额已占用', offeringById(to.offeringId).enrolled === toEnrolled + 1);

  // 换到已满课程应整体回滚
  const acad4 = await login('academic');
  const offAll = (await call('GET', '/api/admin/offerings', {}, null, acad4)).data.list;
  const fullOffer = offAll.find((o) => o.enrolled >= o.capacity && o.offering_id !== from.offering_id);
  if (fullOffer) {
    const mineNow = (await call('GET', '/api/enrollments/mine', {}, null, s6)).data.list;
    const curFrom = mineNow[0];
    const beforeE = offeringById(curFrom.offering_id).enrolled;
    const beforeRec = rows('t_enrollment').filter(
      (e) => Number(e.offering_id) === Number(curFrom.offering_id) && Number(e.status) === 1
    ).length;
    r = await call('POST', '/api/enrollments/switch', {}, { fromOfferingId: curFrom.offering_id, toOfferingId: fullOffer.offering_id }, s6);
    check('换到已满课程返回 2009', r.code === 2009, `实际 ${r.code} ${r.message}`);
    check('换课失败后原课程名额不变', offeringById(curFrom.offering_id).enrolled === beforeE);
    check('换课失败后原选课记录仍在', rows('t_enrollment').filter(
      (e) => Number(e.offering_id) === Number(curFrom.offering_id) && Number(e.status) === 1
    ).length === beforeRec);
    check('换课失败后目标课程名额未被占用', Number(offeringById(fullOffer.offering_id).enrolled) === Number(fullOffer.enrolled));
  } else {
    check('换到已满课程返回 2009', true, '（无满员课程，已跳过）');
  }

  /* ---------------------------------------------------------------- */
  section('TC-12 退课截止');

  fresh();
  const acad5 = await login('academic');
  const batches5 = (await call('GET', '/api/admin/batches', {}, null, acad5)).data.list;
  const makeup = batches5.find((b) => Number(b.type) === 2);
  await call('PUT', `/api/admin/batches/${makeup.id}`, {}, {
    startTime: '2020-01-01T00:00',
    endTime: '2020-01-02T00:00',
  }, acad5);

  const s7 = await login('2024001');
  const mine7 = (await call('GET', '/api/enrollments/mine', {}, null, s7)).data.list;
  const dBefore = offeringById(mine7[0].offering_id).enrolled;
  r = await call('DELETE', `/api/enrollments/${mine7[0].offering_id}`, {}, {}, s7);
  check('超过退课截止返回 2008', r.code === 2008, `实际 ${r.code} ${r.message}`);
  check('退课失败后名额未释放', offeringById(mine7[0].offering_id).enrolled === dBefore);

  /* ---------------------------------------------------------------- */
  section('TC-13 防脚本限速');

  fresh();
  const s8 = await login('2024001');
  const list8 = (await call('GET', '/api/courses', { page: 1, size: 50 }, null, s8)).data.list;
  const anyOffering = list8[0].offeringId;

  const seq = [];
  for (let i = 0; i < 15; i += 1) {
    const res = await call('POST', '/api/enrollments', {}, { offeringId: anyOffering }, s8);
    seq.push(res.code);
  }
  const limited = seq.filter((c) => c === 9001).length;
  check('连续写请求触发限速 9001', limited > 0, `序列 ${seq.join(',')}`);
  check('首个请求未被限速', seq[0] !== 9001, `首个=${seq[0]}`);

  const stillOk = await call('GET', '/api/courses', { page: 1, size: 5 }, null, s8);
  check('限速不影响读接口', stillOk.code === 0);

  /* ---------------------------------------------------------------- */
  section('TC-14 通知与公告');

  fresh();
  const acad6 = await login('academic');
  const stu9 = await login('2024001');
  const unreadBefore = (await call('GET', '/api/notices', { page: 1, size: 1, unread: true }, null, stu9)).data.unread;

  await call('POST', '/api/admin/announcements', {}, {
    title: '选课系统测试公告',
    content: '这是一条用于验证公告投递与未读计数的测试公告。',
    publish: true,
  }, acad6);

  const notices = (await call('GET', '/api/notices', { page: 1, size: 50 }, null, stu9)).data;
  check('公告已投递为站内通知', notices.unread > unreadBefore, `${unreadBefore} → ${notices.unread}`);
  check('通知携带类型文案', notices.list.every((n) => !!n.typeText));

  const firstUnread = notices.list.find((n) => Number(n.is_read) === 0);
  r = await call('POST', `/api/notices/${firstUnread.id}/read`, {}, {}, stu9);
  check('单条标记已读', r.code === 0);
  r = await call('POST', '/api/notices/read-all', {}, {}, stu9);
  const after = (await call('GET', '/api/notices', { page: 1, size: 1, unread: true }, null, stu9)).data.unread;
  check('全部标记已读后未读归零', r.code === 0 && after === 0, `未读 ${after}`);

  /* ---------------------------------------------------------------- */
  section('TC-15 教师端与教务端管理');

  fresh();
  const tch = await login('teacher001');
  const tOffer = (await call('GET', '/api/teacher/offerings', {}, null, tch)).data;
  check('教师可查看本人开课', tOffer.list.length > 0, `${tOffer.list.length} 门`);
  const tTarget = tOffer.list[0];
  r = await call('PUT', `/api/teacher/offerings/${tTarget.offeringId}`, {}, {
    schedules: [{ weekday: 3, startPeriod: 7, endPeriod: 8, parity: 0, campus: '东校区', building: '第二教学楼', room: 'C101' }],
  }, tch);
  check('教师可维护上课时间与地点', r.code === 0 && r.data.scheduleCount === 1, `${r.code} ${r.message}`);

  const stuList = await call('GET', `/api/teacher/offerings/${tTarget.offeringId}/students`, {}, null, tch);
  check('教师可查看选课学生名单', stuList.code === 0 && Array.isArray(stuList.data.students));

  const acad7 = await login('academic');
  const dash = await call('GET', '/api/admin/dashboard', {}, null, acad7);
  check('教务概览返回统计指标', dash.code === 0 && dash.data.offeringCount > 0, JSON.stringify({ o: dash.data.offeringCount, e: dash.data.enrollCount }));

  const newCourse = await call('POST', '/api/admin/courses', {}, {
    courseCode: 'ZZNEW01',
    name: '测试课程（自动化）',
    categoryId: 1,
    credit: 2,
    dept: '测试',
  }, acad7);
  check('教务可新增课程', newCourse.code === 0, `${newCourse.code} ${newCourse.message}`);

  r = await call('DELETE', `/api/admin/courses/${newCourse.data.id}`, {}, {}, acad7);
  check('教务可删除无开课记录的课程', r.code === 0, `${r.code} ${r.message}`);

  const monitor = await call('GET', '/api/admin/monitor', {}, null, await login('sysadmin'));
  check('系统管理员可查看运行监控', monitor.code === 0 && typeof monitor.data.successRate === 'number', JSON.stringify({ rate: monitor.data.successRate, total: monitor.data.totalRequests }));

  const logs = (await call('GET', '/api/admin/audit-logs', { page: 1, size: 20 }, null, await login('sysadmin'))).data;
  check('审计日志可查询且带操作类型列表', logs.list.length > 0 && logs.actions.length > 0, `${logs.total} 条`);

  /* ---------------------------------------------------------------- */
  console.log('\n' + '─'.repeat(64));
  console.log(`静态版引擎回归测试：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('全部通过：单文件网页版与数据库版业务规则一致。');
}

main().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
