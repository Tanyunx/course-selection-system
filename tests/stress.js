'use strict';

/**
 * 多人选课冲突 · 高压压测（stress）
 *
 * 与 concurrency.js 的分工：
 *   concurrency.js 是「功能正确性」——每个场景一次，验证语义对不对；
 *   本脚本是「压力下的不变量」——把同一批不变量放到远超常规的并发强度下反复捶打，
 *   看它们在极端条件下是否仍然成立。两者互补，不是重复。
 *
 * 本脚本要证明的四条不变量（任何时候都不能破）：
 *   A. 不超卖    —— 无论多少人同时抢，最终 enrolled 恰好等于 capacity，且 >= 0
 *   B. 不重复    —— 同一学生并发重复提交，只会产生一条有效选课记录
 *   C. 不丢名额  —— 并发退课 + 候补递补交错后，名额守恒（enrolled = 有效选课记录数）
 *   D. 不脏数据  —— 任何时刻 enrolled 与真实有效选课记录数一致（冗余列不失真）
 *
 * 限速说明：后端对「每个用户」有写操作限速（软阈值 10 次 / 硬阈值 20 次 / 60 秒）。
 * 因此本脚本的并发强度通过「增加参与人数」来提升，而不是靠单用户狂刷；
 * 单用户狂刷的场景（场景 2/3）会显式容忍 9001 限速码并把有效结果单独断言。
 * 对于需要「同一学生连续多次写操作」的场景，脚本会在开始前等待一个限速窗口
 * （默认 62 秒，可用 STRESS_COOLDOWN_SECONDS 覆盖，设为 0 可关闭）。
 * 完整跑一轮约需 3 分钟，其中大部分时间是这些等待。
 * 这是刻意的：限速本身就是要验证的行为之一，等待是确定性的，不靠运气重试。
 *
 * 用法：node tests/stress.js [baseUrl]
 *      默认 http://127.0.0.1:3000
 *      STRESS_COOLDOWN_SECONDS=0 node tests/stress.js   # 跳过等待（会因限速报假红）
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const ACADEMIC = { username: 'academic', secret: '123456' };

/** 种子数据里的全部 8 名学生 */
const STUDENT_SEED = [
  '2023001', '2023002', '2023003', '2024001',
  '2024002', '2024003', '2025001', '2025002',
];

let seq = 0;
const rid = (tag) => `stress-${tag}-${Date.now()}-${++seq}`;

async function call(method, path, { token, body } = {}) {
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json().catch(() => null);
  } catch (e) {
    return { code: -1, message: 'network: ' + e.message };
  }
}

async function login(username) {
  const r = await call('POST', '/api/auth/login', { body: { username, password: '123456' } });
  if (!r || r.code !== 0) throw new Error(`登录失败 ${username}: ${r && r.message}`);
  return r.data.token;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`  ${ok ? '通过' : '失败'}  ${name}${detail === undefined ? '' : '  → ' + detail}`);
}

/** 批量并发执行，返回按输入顺序排列的结果 */
async function parallel(tasks) {
  return Promise.all(tasks.map((t) => t()));
}

/**
 * 建一门容量为 capacity 的低学分新课（不排课 → 不产生时间冲突）。
 *
 * <p>唯一约束是 (courseId, teacherId)，所以同一门课换一位教师就能再开一个班。
 * 低学分课程只有 5 门、教师只有 4 位，而本脚本要建 7 门测试课，
 * 因此**不能**按"一门课只用一次"去筛选，否则跑到场景 5 就会没课可用。
 * 这里改为按"课程 × 教师"组合遍历，只要这一对没被占用就可以开。
 *
 * <p>仍保留 `usedCourseIds` 参数（场景内部用它避免自撞），但不再作为硬过滤条件。
 */
async function createOffering(token, courses, teachers, capacity, usedCourseIds, existingPairs, campus) {
  const eligible = courses.filter((c) => Number(c.credit) <= 2);
  // 第一轮：优先挑「本场景内还没用过的课程」，保证场景内部各开课互不相同；
  // 若全都用过（低学分课只有 5 门，场景 5 要 3 门），再退而求其次复用课程、换个教师。
  for (const pass of ['fresh', 'any']) {
    for (const course of eligible) {
      if (pass === 'fresh' && usedCourseIds.has(Number(course.id))) continue;
      for (const teacher of teachers) {
        const key = course.id + '|' + teacher.id;
        if (existingPairs.has(key)) continue;
        const r = await call('POST', '/api/admin/offerings', {
          token,
          body: {
            courseId: Number(course.id),
            teacherId: Number(teacher.id),
            capacity,
            campus: campus || '并发测试校区',
            remark: '压力测试自动创建',
          },
        });
        if (!r || r.code !== 0) throw new Error(`创建开课失败：${r && r.message}`);
        usedCourseIds.add(Number(course.id));
        existingPairs.add(key);
        return { offeringId: r.data.offeringId, courseName: course.name };
      }
    }
  }
  throw new Error('找不到可用于测试的「低学分课程 + 教师」组合（库可能被前次测试占满，请先 --init 重建）');
}

/** 从教务开课列表取某门课的实时状态 */
async function offeringOf(token, offeringId) {
  const r = await call('GET', '/api/admin/offerings', { token });
  if (!r || r.code !== 0) throw new Error('查询开课失败');
  const row = r.data.list.find((x) => Number(x.offering_id) === Number(offeringId));
  if (!row) throw new Error(`教务开课列表中找不到 offeringId=${offeringId}`);
  return row;
}

/**
 * 直接从数据库口径校验「冗余列 enrolled」与「真实有效选课记录数」是否一致。
 * 走教务端的 enrolledCount 字段（后端已按 status=1 统计），无需直连数据库。
 */
async function consistency(token, offeringId) {
  const o = await offeringOf(token, offeringId);
  const enrolled = Number(o.enrolled);
  const records = Number(o.enrolledCount);
  return { enrolled, records, capacity: Number(o.capacity), consistent: enrolled === records };
}

async function main() {
  console.log(`多人选课高压压测目标：${BASE}\n`);

  const health = await call('GET', '/api/health');
  if (!health || health.code !== 0) {
    console.error('后端未就绪，请先启动服务');
    process.exit(1);
  }

  const academic = await login(ACADEMIC.username);
  const room = await call('GET', '/api/admin/offerings', { token: academic });
  const courses = room.data.courses;
  const teachers = room.data.teachers;
  // 场景 4/5 里需要「同一名学生同时持有/操作多门课」，这些课必须来自**不同的课程**
  // （同一门课的两个开课班不能被同一名学生同时选上）。因此用 usedCourseIds 记录
  // 这些场景内部已经用掉的课程，保证互不重复；跨场景则不限制（同课换教师即可）。
  const usedCourseIds = new Set();
  const existingPairs = new Set((room.data.list || []).map((x) => `${x.course_id}|${x.teacher_id}`));

  const tokens = await parallel(STUDENT_SEED.map((u) => async () => [u, await login(u)]));
  const tokenOf = new Map(tokens);

  /**
   * 取一批"干净"的学生令牌，供单个场景独占使用。
   *
   * <p><b>为什么每个场景都要换人：</b>后端限速是<b>按用户</b>计数的
   * （软阈值 10 次 / 硬阈值 20 次 / 60 秒窗口）。一个场景跑下来，
   * 参与的学生往往已经用掉十几个名额；如果下一个场景继续用同一批人，
   * 请求会被 9001 挡掉，测试报"失败"但其实是把限速当成了并发缺陷 —— 假红。
   *
   * <p>所以每个场景从 8 名学生里取一段专属区间；学生不够时回绕复用，
   * 但会显式提示"本场景可能受限速影响"，让结果可解释。
   */
  let cursor = 0;
  function takeStudents(n, label) {
    const picked = [];
    for (let i = 0; i < n; i++) {
      if (cursor >= STUDENT_SEED.length) {
        console.log(`    提示：学生名额已用尽，场景「${label}」回绕复用令牌，可能触发 9001 限速`);
        cursor = 0;
      }
      picked.push(STUDENT_SEED[cursor++]);
    }
    return picked.map((u) => tokenOf.get(u));
  }

  /**
   * 等待限速窗口滑过。
   *
   * <p>种子数据只有 8 名学生，而限速的窗口是 60 秒、软阈值 10 次。
   * 场景 1 让 8 个人每人打 3 轮，刚好把多数人的额度用掉大半；
   * 如果紧接着跑场景 5，同一位学生的"选来源课"就会被 9001 挡掉，
   * 于是场景 5 会呈现"一次都没成功"的假红。
   *
   * <p>这里在重负载场景之间主动等待一个窗口长度。等待是<b>确定性</b>的，
   * 不依赖重试运气，也如实反映"限速确实存在且生效"这一事实。
   */
  async function cooldown(reason) {
    const seconds = Number(process.env.STRESS_COOLDOWN_SECONDS || 62);
    if (seconds <= 0) return;
    console.log(`  · 等待 ${seconds} 秒让限速窗口滑过（${reason}）…`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }

  // 场景 1 独占前 8 名（它是唯一需要"全员"的场景）
  const allTokens = takeStudents(STUDENT_SEED.length, '场景1');

  /* ================================================================= */
  /* 场景 1：全员反复争夺 —— 强度是 concurrency.js 的数倍               */
  /* ================================================================= */
  console.log('场景 1：8 名学生 × 每人多轮，反复争夺容量 3 的同一门课');
  const CAP = 3;
  const ROUNDS = 3;
  const s1 = await createOffering(academic, courses, teachers, CAP, usedCourseIds, existingPairs,
    '压力测试校区');

  // 每轮全员同时发起；同一学生跨轮换新 requestId（模拟"反复抢"而非"重复提交"）
  const roundCodes = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const responses = await parallel(allTokens.map((tk, i) => () =>
      call('POST', '/api/enrollments', {
        token: tk,
        body: { offeringId: s1.offeringId, requestId: rid(`s1-r${round}-s${i}`) },
      })
    ));
    roundCodes.push(responses.map((r) => (r ? r.code : 'null')));
  }

  const flat = roundCodes.flat();
  const okCount = flat.filter((c) => c === 0).length;
  const fullCount = flat.filter((c) => c === 2001).length;
  const limitCount = flat.filter((c) => c === 9001).length;
  const dupCount = flat.filter((c) => c === 2006).length;
  // 2006「已选该课程，无需重复选课」是**正确语义**：第 2、3 轮里，
  // 已经抢到课的学生再次提交，本就该被告知"你已经选上了"。
  // 只有 2001（已满）、9001（限速）、2006（已选）这三种是预期结果；
  // 出现 2002/2003/2014/9002 之类才说明真的出了问题。
  const odd = flat.filter((c) => c !== 0 && c !== 2001 && c !== 9001 && c !== 2006);

  console.log(`    各轮结果码：${roundCodes.map((r) => '[' + r.join(',') + ']').join(' ')}`);

  check('成功次数恰好等于容量（不多占一个名额）', okCount === CAP,
    `成功 ${okCount} 次 / 容量 ${CAP}`);
  check('其余请求被拦截为「已满 / 已选 / 限速」，无异常码', odd.length === 0,
    odd.length ? `异常码 ${odd.join(',')}`
      : `2001×${fullCount}，2006×${dupCount}，9001×${limitCount}`);

  const c1 = await consistency(academic, s1.offeringId);
  check('enrolled 严格等于容量（未超卖）', c1.enrolled === CAP,
    `enrolled=${c1.enrolled} capacity=${c1.capacity}`);
  check('enrolled 与有效选课记录数一致（冗余列未失真）', c1.consistent,
    `enrolled=${c1.enrolled} 记录=${c1.records}`);
  check('remaining 不为负', c1.enrolled <= c1.capacity,
    `enrolled=${c1.enrolled} capacity=${c1.capacity}`);

  /* ================================================================= */
  /* 场景 2：同一学生并发重复提交（唯一约束 + 幂等的兜底）              */
  /* ================================================================= */
  console.log('\n场景 2：同一学生并发提交同一 requestId（10 个请求同时打）');
  // 本场景要用同一名学生连打 10 次，必须让它从"满额度"状态开始，
  // 否则 10 个请求会被限速吃掉大半，测不出幂等本身的行为
  await cooldown('场景 2 需要同一学生的完整额度');
  const s2 = await createOffering(academic, courses, teachers, 5, usedCourseIds, existingPairs,
    '压力测试校区');
  const sameRid = rid('s2-same');
  const sameToken = allTokens[0];

  const sameSubmit = await parallel(
    Array.from({ length: 10 }, () => () =>
      call('POST', '/api/enrollments', {
        token: sameToken, body: { offeringId: s2.offeringId, requestId: sameRid },
      })
    )
  );
  const sameOk = sameSubmit.filter((r) => r && r.code === 0).length;
  const sameLimit = sameSubmit.filter((r) => r && r.code === 9001).length;

  const c2 = await consistency(academic, s2.offeringId);
  check('同一 requestId 并发提交只占 1 个名额', c2.enrolled === 1,
    `enrolled=${c2.enrolled}（成功 ${sameOk} 次，限速 ${sameLimit} 次）`);
  check('只产生 1 条选课记录（未重复插入）', c2.records === 1, `记录 ${c2.records} 条`);
  check('冗余列与记录数一致', c2.consistent, `enrolled=${c2.enrolled} 记录=${c2.records}`);

  /* ================================================================= */
  /* 场景 3：同一学生并发提交「不同 requestId」（考验唯一约束）          */
  /* ================================================================= */
  console.log('\n场景 3：同一学生并发提交不同 requestId（绕过幂等，考验唯一约束）');
  await cooldown('场景 3 需要另一名学生的完整额度');
  const s3 = await createOffering(academic, courses, teachers, 5, usedCourseIds, existingPairs,
    '压力测试校区');

  const diffSubmit = await parallel(
    Array.from({ length: 6 }, (_, i) => () =>
      call('POST', '/api/enrollments', {
        token: allTokens[1], body: { offeringId: s3.offeringId, requestId: rid(`s3-d${i}`) },
      })
    )
  );
  const diffOk = diffSubmit.filter((r) => r && r.code === 0).length;
  const diffLimit = diffSubmit.filter((r) => r && r.code === 9001).length;
  const diffOther = diffSubmit.filter((r) => r && r.code !== 0 && r.code !== 9001);

  const c3 = await consistency(academic, s3.offeringId);
  check('同一学生最多只占 1 个名额', c3.enrolled === 1,
    `enrolled=${c3.enrolled}（成功 ${diffOk} 次，限速 ${diffLimit} 次）`);
  check('只留下 1 条有效选课记录', c3.records === 1, `记录 ${c3.records} 条`);
  check('冗余列与记录数一致', c3.consistent, `enrolled=${c3.enrolled} 记录=${c3.records}`);
  if (diffOther.length) {
    console.log(`    （附加信息：非 0 非 9001 的返回码 ${diffOther.map((r) => r.code).join(',')}）`);
  }

  /* ================================================================= */
  /* 场景 4：并发退课 + 候补递补交错 —— 名额守恒                        */
  /* ================================================================= */
  console.log('\n场景 4：容量 2 的课，2 人在读 + 3 人候补，并发退课触发递补');
  // 本场景每人只发 1~2 次请求（5 名学生：2 人抢座、3 人进候补），
  // 额度充裕，不必等待；等待反而拖长总时长。
  const s4 = await createOffering(academic, courses, teachers, 2, usedCourseIds, existingPairs,
    '压力测试校区');
  const holders = [allTokens[2], allTokens[3]];
  const waiters = [allTokens[4], allTokens[5], allTokens[6]];
  const waiterNames = [STUDENT_SEED[4], STUDENT_SEED[5], STUDENT_SEED[6]];

  // 先让 2 人占满
  const enrollRes = await parallel(holders.map((tk, i) => () =>
    call('POST', '/api/enrollments', {
      token: tk, body: { offeringId: s4.offeringId, requestId: rid(`s4-h${i}`) },
    })
  ));
  check('2 名在读学生占满容量', enrollRes.every((r) => r && r.code === 0),
    enrollRes.map((r) => r && r.code).join(','));

  // 3 人依次加入候补（顺序加入，保证排位确定）
  for (let i = 0; i < waiters.length; i++) {
    const w = await call('POST', '/api/waitlist', {
      token: waiters[i], body: { offeringId: s4.offeringId, requestId: rid(`s4-w${i}`) },
    });
    if (!w || w.code !== 0) {
      console.log(`    （候补第 ${i + 1} 位加入失败：${w && w.code} ${w && w.message}）`);
    }
  }

  // 并发退课：两个在读学生同时退
  const dropRes = await parallel(holders.map((tk, i) => () =>
    call('DELETE', `/api/enrollments/${s4.offeringId}?requestId=${rid(`s4-drop${i}`)}`, { token: tk })
  ));
  const droppedOk = dropRes.filter((r) => r && r.code === 0).length;
  check('并发退课均成功', droppedOk === 2, `成功 ${droppedOk}/2`);

  const c4 = await consistency(academic, s4.offeringId);
  check('名额守恒：enrolled == 有效选课记录数', c4.consistent,
    `enrolled=${c4.enrolled} 记录=${c4.records}`);
  check('未出现负名额或超容量', c4.enrolled >= 0 && c4.enrolled <= c4.capacity,
    `enrolled=${c4.enrolled} capacity=${c4.capacity}`);

  // 递补应把名额给候补队列的顺序靠前者
  const promotedNames = [];
  for (let i = 0; i < waiters.length; i++) {
    const mine = await call('GET', '/api/enrollments/mine', { token: waiters[i] });
    const has = mine && mine.data
      && mine.data.list.some((x) => Number(x.offering_id) === Number(s4.offeringId));
    if (has) promotedNames.push(waiterNames[i]);
  }
  check('递补人数不超过释放出的名额（2 个）', promotedNames.length <= 2,
    `递补 ${promotedNames.length} 人：${promotedNames.join(',') || '无'}`);
  check('递补按候补顺序从前到后（不是随机挑）',
    promotedNames.length === 0 || promotedNames[0] === waiterNames[0],
    `首位递补=${promotedNames[0] || '无'}，候选顺序=${waiterNames.join('>')}`);

  const c4b = await consistency(academic, s4.offeringId);
  check('递补后仍守恒（enrolled == 记录数）', c4b.consistent,
    `enrolled=${c4b.enrolled} 记录=${c4b.records}`);

  /* ================================================================= */
  /* 场景 5：两人并发换课到同一门满课 —— 只能有一人成功                 */
  /* ================================================================= */
  console.log('\n场景 5：两名学生同时换课到同一门只剩 1 个名额的课');
  // 场景 1 让 8 名学生各打了 3 轮选课，额度已消耗大半；
  // 场景 5 还需要"选来源课 + 换课"两次写操作，因此先等窗口滑过再开始，
  // 否则会因 9001 导致"一次都没成功"的假红。
  await cooldown('场景 5 需要两名学生的完整额度');
  const target = await createOffering(academic, courses, teachers, 1, usedCourseIds, existingPairs,
    '压力测试校区');
  // 另建两门"来源课"，让两名学生各自先有一门在读课
  const srcA = await createOffering(academic, courses, teachers, 5, usedCourseIds, existingPairs,
    '压力测试校区');
  const srcB = await createOffering(academic, courses, teachers, 5, usedCourseIds, existingPairs,
    '压力测试校区');

  const swA = allTokens[0];
  const swB = allTokens[1];
  // 先让两人各自选上一门"来源课"。这里必须**校验结果**，否则一旦前置选课失败，
  // 后面的换课会因为"尚未选修原课程"而全部失败，测试却看起来"没有超卖"——假绿。
  const preA = await call('POST', '/api/enrollments', {
    token: swA, body: { offeringId: srcA.offeringId, requestId: rid('s5-a-pre') },
  });
  const preB = await call('POST', '/api/enrollments', {
    token: swB, body: { offeringId: srcB.offeringId, requestId: rid('s5-b-pre') },
  });
  check('前置条件：两名学生均已选上各自的来源课',
    preA && preA.code === 0 && preB && preB.code === 0,
    `A=${preA && preA.code}(${preA && preA.message || ''})，B=${preB && preB.code}(${preB && preB.message || ''})`);

  const switchRes = await parallel([
    () => call('POST', '/api/enrollments/switch', {
      token: swA,
      body: { fromOfferingId: srcA.offeringId, toOfferingId: target.offeringId, requestId: rid('s5-a') },
    }),
    () => call('POST', '/api/enrollments/switch', {
      token: swB,
      body: { fromOfferingId: srcB.offeringId, toOfferingId: target.offeringId, requestId: rid('s5-b') },
    }),
  ]);
  const swOk = switchRes.filter((r) => r && r.code === 0).length;
  const swDetail = switchRes.map((r) => (r ? r.code : 'null')).join(',');

  const c5 = await consistency(academic, target.offeringId);
  check('并发换课恰好一人成功（不超卖、也不一起失败）', swOk === 1,
    `成功 ${swOk} 次，返回码 [${swDetail}]，enrolled=${c5.enrolled} capacity=${c5.capacity}`);
  check('目标课最多只被占 1 个名额（并发换课未超卖）', c5.enrolled <= 1,
    `enrolled=${c5.enrolled} capacity=${c5.capacity}，成功 ${swOk} 次`);
  check('目标课冗余列与记录数一致', c5.consistent,
    `enrolled=${c5.enrolled} 记录=${c5.records}`);

  // 赢得名额的一方应已转入目标课；失败方必须保留原课（换课是"先占后放"，失败不能丢原名额）
  const stillHasA = await call('GET', '/api/enrollments/mine', { token: swA });
  const stillHasB = await call('GET', '/api/enrollments/mine', { token: swB });
  const aKeeps = stillHasA.data.list.some(
    (x) => Number(x.offering_id) === Number(srcA.offeringId));
  const bKeeps = stillHasB.data.list.some(
    (x) => Number(x.offering_id) === Number(srcB.offeringId));
  // 恰好一人成功时，失败的另一方必须仍持有自己的来源课
  check('换课失败方保留原课程（未丢名额）',
    swOk !== 1 || (aKeeps !== bKeeps),
    `A 保留原课=${aKeeps}，B 保留原课=${bKeeps}，成功 ${swOk} 次`);

  /* ================================================================= */
  /* 汇总                                                              */
  /* ================================================================= */
  const pass = results.filter((r) => r.ok).length;
  console.log('\n────────────────────────────────────────────────');
  console.log(`压力测试：共 ${results.length} 项，通过 ${pass} 项，失败 ${results.length - pass} 项`);
  if (pass === results.length) {
    console.log('全部通过：多人选课在高压并发下未出现超卖、重复、丢名额或数据不一致。');
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('压力测试异常：', e.message);
  process.exit(1);
});
