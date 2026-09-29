/**
 * 前端集成验证：用 jsdom 加载真实页面并对接真实后端，
 * 覆盖登录、按角色渲染菜单、逐页渲染，捕获运行期异常与错误提示。
 *
 * 用法：node .uicheck/ui-check.js [baseUrl]
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const PROJECT = path.join(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const ACCOUNTS = {
  student: { user: '2024001', role: '学生' },
  teacher: { user: 'teacher001', role: '教师' },
  academic: { user: 'academic', role: '教务管理员' },
  sysadmin: { user: 'sysadmin', role: '系统管理员' },
};
const SECRET = process.env.DEMO_SECRET || '123456';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail: String(detail) });
}

/** 准备一份 ESM 版本的 public/js 副本（package.json 声明 type=module） */
function prepareEsmCopy() {
  const src = path.join(PROJECT, 'public', 'js');
  const dst = path.join(__dirname, 'esm', 'js');
  fs.rmSync(path.join(__dirname, 'esm'), { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const copy = (from, to) => {
    for (const name of fs.readdirSync(from)) {
      const s = path.join(from, name);
      const d = path.join(to, name);
      if (fs.statSync(s).isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copy(s, d);
      } else if (name.endsWith('.js')) {
        fs.copyFileSync(s, d);
      }
    }
  };
  copy(src, dst);
  fs.writeFileSync(path.join(__dirname, 'esm', 'package.json'), JSON.stringify({ type: 'module' }));
  return dst;
}

async function boot(dom, esmDir) {
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  } catch (_) {
    /* Node 中 navigator 只读时忽略 */
  }
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.scrollTo = () => {};

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    let url = input;
    if (typeof input === 'string' && input.startsWith('/')) url = BASE + input;
    return realFetch(url, init);
  };

  const mod = await import(pathToFileURL(path.join(esmDir, 'app.js')).href);
  return mod;
}

async function main() {
  const errors = [];
  process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && e.message)));
  process.on('uncaughtException', (e) => errors.push('uncaughtException: ' + (e && e.message)));

  const html = fs.readFileSync(path.join(PROJECT, 'public', 'index.html'), 'utf8');
  const esmDir = prepareEsmCopy();
  check('准备前端 ESM 副本', true, esmDir.replace(PROJECT, '.'));

  const dom = new JSDOM(html, { url: BASE + '/', pretendToBeVisual: true });
  dom.window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  const consoleErrors = [];
  dom.window.console.error = (...a) => consoleErrors.push(a.map(String).join(' '));

  await boot(dom, esmDir);
  await wait(600);

  const doc = dom.window.document;
  check('页面初始化：登录页可见', !doc.getElementById('login-page').hidden, '');
  check('页面初始化：演示账号按钮已渲染', doc.querySelectorAll('#demo-list button').length >= 4, `${doc.querySelectorAll('#demo-list button').length} 个`);

  // 静态检查：[hidden] 兜底规则必须存在，否则类选择器的 display 会覆盖 hidden 属性
  const cssText = fs.readFileSync(path.join(PROJECT, 'public', 'css', 'app.css'), 'utf8');
  check(
    'CSS 保留 [hidden] 兜底规则',
    /\[hidden\]\s*\{[^}]*display:\s*none[^}]*!important/.test(cssText),
    ''
  );

  // ---------------- 按角色逐一轮询 ----------------
  const PLANS = {
    student: ['courses', 'timetable', 'my', 'waitlist', 'notices', 'rules'],
    teacher: ['t/offerings', 't/students', 'notices'],
    academic: ['a/dashboard', 'a/courses', 'a/offerings', 'a/quota', 'a/batches', 'a/credits', 'a/announcements', 'notices'],
    sysadmin: ['s/users', 's/logs', 's/monitor', 'notices'],
  };

  for (const [key, routes] of Object.entries(PLANS)) {
    const acc = ACCOUNTS[key];

    // 重置到登录页
    dom.window.localStorage.clear();
    dom.window.location.hash = '';
    doc.getElementById('login-page').hidden = false;
    doc.getElementById('app').hidden = true;

    doc.getElementById('login-username').value = acc.user;
    doc.getElementById('login-password').value = SECRET;
    doc.getElementById('login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true }));
    await wait(1600);

    const loggedIn = !doc.getElementById('app').hidden;
    const roleText = doc.getElementById('user-role').textContent;
    check(`[${acc.role}] 登录成功`, loggedIn, loggedIn ? `顶部身份显示「${roleText}」` : '登录失败或页面未切换');

    const navItems = [...doc.querySelectorAll('#side-nav .nav-item')].map((b) => b.dataset.path);
    check(`[${acc.role}] 按角色生成菜单`, navItems.length === routes.length, `菜单项：${navItems.join(' / ')}`);

    for (const r of routes) {
      dom.window.location.hash = '#/' + r;
      // jsdom 中 hashchange 会自动触发；手动派发以兼容
      dom.window.dispatchEvent(new dom.window.Event('hashchange'));
      await wait(900);
      const content = doc.getElementById('content');
      const text = content.textContent || '';
      const hasError = !!content.querySelector('.alert-error');
      const errText = hasError ? content.querySelector('.alert-error').textContent.trim().slice(0, 80) : '';
      const loaded = text.length > 5 && !text.includes('页面加载失败');
      check(`[${acc.role}] 渲染 #/${r}`, loaded && !hasError, hasError ? `错误提示：${errText}` : `渲染内容 ${text.length} 字`);
    }

    // 退出登录
    doc.getElementById('logout-btn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await wait(400);
  }

  // ---------------- 验证码链路（连续失败触发 → 作答 → 登录成功） ----------------
  dom.window.localStorage.clear();
  doc.getElementById('login-username').value = ACCOUNTS.student.user;
  doc.getElementById('login-password').value = SECRET + '-wrong';
  for (let i = 0; i < 5; i += 1) {
    doc.getElementById('login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true }));
    await wait(700);
  }
  const captchaShown = !doc.getElementById('captcha-field').hidden;
  const qText = (doc.getElementById('captcha-refresh').textContent || '').trim();
  check('连续失败后出现验证码', captchaShown, captchaShown ? `题目：${qText}` : '验证码区未显示');
  check('验证码题目已加载', /\d+\s*[+−]\s*\d+\s*=\s*\?/.test(qText), qText);
  const mQ = qText.match(/(\d+)\s*([+−])\s*(\d+)/);
  if (mQ) {
    const ans = mQ[2] === '+' ? Number(mQ[1]) + Number(mQ[3]) : Number(mQ[1]) - Number(mQ[3]);
    doc.getElementById('login-captcha').value = String(ans);
    doc.getElementById('login-password').value = SECRET;
    doc.getElementById('login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true }));
    await wait(1500);
    check(
      '验证码作答后登录成功',
      !doc.getElementById('app').hidden,
      doc.getElementById('app').hidden ? '登录未通过' : `身份：${doc.getElementById('user-role').textContent}`
    );
  }

  // ---------------- 学生端关键交互 ----------------
  dom.window.localStorage.clear();
  doc.getElementById('login-username').value = ACCOUNTS.student.user;
  doc.getElementById('login-password').value = SECRET;
  doc.getElementById('login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true }));
  await wait(1500);
  dom.window.location.hash = '#/courses';
  dom.window.dispatchEvent(new dom.window.Event('hashchange'));
  await wait(1000);

  const cards = doc.querySelectorAll('.course-card');
  check('选课中心渲染课程卡片', cards.length > 0, `${cards.length} 张卡片`);

  const statusBadges = [...doc.querySelectorAll('.course-card .badge')].map((b) => b.textContent.trim());
  const hasStatus = ['可选', '已满', '时间冲突', '已选', '条件不符', '批次外', '候补中'].some((s) =>
    statusBadges.some((b) => b.includes(s))
  );
  check('课程卡片展示选课状态标签', hasStatus, `出现状态：${[...new Set(statusBadges)].slice(0, 8).join('、')}`);

  const progress = doc.querySelectorAll('.course-card .progress i').length;
  check('课程卡片展示热度进度条', progress > 0, `${progress} 条进度条`);

  // 打开开课详情弹窗
  const detailBtn = doc.querySelector('.course-card [data-action="detail"]');
  if (detailBtn) {
    detailBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await wait(900);
    const modal = doc.querySelector('.modal-mask .modal');
    const footBtns = modal ? [...modal.querySelectorAll('.modal-foot button')].map((b) => b.textContent.trim()) : [];
    check('开课详情弹窗可打开并渲染页脚按钮', !!modal && footBtns.length > 0, footBtns.join(' / ') || '未渲染页脚');
    const closeBtn = doc.querySelector('.modal-mask [data-close]');
    if (closeBtn) closeBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await wait(200);
  } else {
    check('开课详情弹窗可打开并渲染页脚按钮', false, '未找到详情按钮');
  }

  // 课表页
  dom.window.location.hash = '#/timetable';
  dom.window.dispatchEvent(new dom.window.Event('hashchange'));
  await wait(1000);
  const cells = doc.querySelectorAll('.timetable .slot').length;
  check('我的课表渲染周视图', cells > 0, `${cells} 个课程单元格`);

  // 节次时间须与学校《课时表》一致
  const ttText = doc.getElementById('content').textContent || '';
  const ttRows = doc.querySelectorAll('#content .timetable tbody tr').length;
  check('课表默认展示全天 13 节（上午/下午/晚上）', ttRows === 13, `${ttRows} 行`);
  check('课表含「时段」列', /时段/.test(ttText) && /上午/.test(ttText));
  check('课表节次时间与课时表一致（08:00-08:40）', ttText.includes('08:00-08:40'), '');
  check('课表不出现「大节X」冗余标注', !/大节[一二三四五]/.test(ttText), '课表左侧仅保留时段 / 节次 / 时间');
  check('课表含晚上时段（11~13 节）', /晚上/.test(ttText) && ttText.includes('18:00-18:40'));

  // 勾选「只看有课节次」后应压缩渲染
  const compactBox = doc.getElementById('tt-compact');
  if (compactBox) {
    compactBox.checked = true;
    compactBox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await wait(1200);
    const compactRows = doc.querySelectorAll('#content .timetable tbody tr').length;
    check('勾选后压缩为有课节次', compactRows > 0 && compactRows < 13, `${compactRows} 行`);
    compactBox.checked = false;
    compactBox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await wait(1200);
  } else {
    check('勾选后压缩为有课节次', false, '未找到紧凑模式开关');
  }

  // 课时表（选课规则页）
  dom.window.location.hash = '#/rules';
  dom.window.dispatchEvent(new dom.window.Event('hashchange'));
  await wait(1200);
  const ptRows = doc.querySelectorAll('#content .period-table tbody tr').length;
  const ptText = doc.getElementById('content').textContent || '';
  check('选课规则页含课时表（13 节）', ptRows === 13, `${ptRows} 行`);
  check(
    '课时表时间抽查：第 6 节 13:00-13:40、第 11 节 18:00-18:40',
    ptText.includes('13:00-13:40') && ptText.includes('18:00-18:40')
  );

  // 二次确认弹窗（退课确认）
  dom.window.location.hash = '#/my';
  dom.window.dispatchEvent(new dom.window.Event('hashchange'));
  await wait(1000);
  const dropBtn = doc.querySelector('[data-drop]');
  if (dropBtn) {
    dropBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await wait(400);
    const okBtn = doc.querySelector('.modal-mask [data-ok]');
    const cancelBtn = doc.querySelector('.modal-mask [data-cancel]');
    check('破坏性操作有二次确认弹窗', !!okBtn && !!cancelBtn, okBtn ? `确认按钮：${okBtn.textContent.trim()}` : '未弹出确认框');
    if (cancelBtn) cancelBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await wait(300);
    check('取消后确认框关闭', !doc.querySelector('.modal-mask'), '');
  } else {
    check('破坏性操作有二次确认弹窗', false, '当前账号没有可退课程');
    check('取消后确认框关闭', false, '跳过');
  }

  check('未出现未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | ') || '无');
  check('未出现控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无');

  console.log('前端集成验证结果：');
  results.forEach((r) => {
    console.log(`  ${r.pass ? '通过' : '失败'}  ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
  });
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n共 ${results.length} 项，通过 ${pass} 项，失败 ${results.length - pass} 项`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('前端集成验证异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
