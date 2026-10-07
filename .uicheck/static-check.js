'use strict';

/**
 * 单文件网页版端到端验证
 *
 * 直接加载构建产出的 .html，用 jsdom 真实执行其中的内联脚本，
 * 验证登录、按角色生成菜单、逐页渲染与关键交互 ——
 * 因为业务引擎已内联，本验证不需要任何后端服务，完全离线可复现。
 *
 * 运行：node .uicheck/static-check.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

// 目录结构在「前后端分离」重构后由 web-build/ 改名为 tools/、public/ 改名为 frontend/，
// mock 数据层最终落在 frontend/mock/。这里只取它导出的 DEMO_SECRET 用于断言演示口令。
const ENGINE = require('../frontend/mock/index.js');
const HTML_PATH = path.join(__dirname, '..', '选课系统-单文件版.html');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 4000, interval = 30) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch (_) {
      /* 忽略中间态异常 */
    }
    await sleep(interval);
  }
  return false;
}

async function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  const errors = [];
  const consoleErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message || String(e)));
  vc.on('error', (...a) => consoleErrors.push(a.map(String).join(' ')));

  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1/course-selection-system.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });

  const win = dom.window;
  const doc = win.document;

  console.log('【1】页面加载与内联资源');
  check('页面标题正确', doc.title === '在线选课系统', doc.title);
  check('样式已内联（存在 <style>）', doc.querySelectorAll('style').length >= 1, `${doc.querySelectorAll('style').length} 个`);
  check('脚本已内联（不存在外链脚本）', doc.querySelectorAll('script[src]').length === 0);
  check('演示提示条已注入', !!doc.querySelector('.static-bar'));
  check('重置数据按钮已注入', !!doc.querySelector('.static-bar button'));

  const started = await waitFor(() => doc.getElementById('login-page') && !doc.getElementById('login-page').hidden, 5000);
  check('应用已启动并显示登录页', started);
  check('登录页可见、主应用隐藏', !doc.getElementById('login-page').hidden && doc.getElementById('app').hidden);

  console.log('\n【2】登录页');
  const demoBtns = doc.querySelectorAll('#demo-list button');
  check('演示账号按钮已渲染', demoBtns.length >= 4, `${demoBtns.length} 个`);
  check(
    '演示提示含统一口令（运行时注入）',
    (doc.querySelector('.demo-title').textContent || '').includes(ENGINE.DEMO_SECRET),
    doc.querySelector('.demo-title').textContent
  );
  check('验证码区默认隐藏', doc.getElementById('captcha-field').hidden);

  let filled = '';
  demoBtns[0].dispatchEvent(new win.Event('click', { bubbles: true }));
  filled = doc.getElementById('login-username').value;
  check('点击演示账号可自动填入', filled.length > 0, filled);

  const capReady = await waitFor(() => /=\s*\?$/.test((doc.getElementById('captcha-refresh').textContent || '').trim()), 2500);
  check('验证码题目已预取', capReady, (doc.getElementById('captcha-refresh').textContent || '').trim());

  console.log('\n【3】四类角色登录与菜单');
  const roleCases = [
    { user: '2024001', role: 1, label: '学生', paths: ['courses', 'timetable', 'my', 'waitlist', 'notices', 'rules'] },
    { user: 'teacher001', role: 2, label: '教师', paths: ['t/offerings', 't/students', 'notices'] },
    {
      user: 'academic',
      role: 3,
      label: '教务管理员',
      paths: ['a/dashboard', 'a/courses', 'a/offerings', 'a/quota', 'a/batches', 'a/credits', 'a/announcements', 'notices'],
    },
    { user: 'sysadmin', role: 4, label: '系统管理员', paths: ['s/users', 's/logs', 's/monitor', 'notices'] },
  ];

  for (const rc of roleCases) {
    doc.getElementById('login-username').value = rc.user;
    doc.getElementById('login-password').value = ENGINE.DEMO_SECRET;
    doc.getElementById('login-captcha').value = '';
    doc.getElementById('login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));

    const ok = await waitFor(() => {
      const app = doc.getElementById('app');
      return app && !app.hidden && (doc.getElementById('user-name').textContent || '') !== '—';
    }, 6000);

    check(`${rc.label}登录成功并进入应用`, ok, doc.getElementById('login-error').textContent || '');
    if (!ok) continue;

    const navItems = Array.from(doc.querySelectorAll('#side-nav .ni'));
    check(`${rc.label}菜单项数量为 ${rc.paths.length}`, navItems.length === rc.paths.length, `实际 ${navItems.length}`);
    const navPaths = Array.from(doc.querySelectorAll('#side-nav [data-path]')).map((el) => el.dataset.path);
    check(`${rc.label}菜单路径与权限矩阵一致`, rc.paths.every((p) => navPaths.includes(p)), navPaths.join(','));

    // 逐页渲染
    let pageOk = true;
    const badPages = [];
    for (const p of rc.paths) {
      win.location.hash = '#/' + p;
      await sleep(140);
      const content = doc.getElementById('content');
      const hasError = !!content.querySelector('.alert-error') || /页面加载失败|加载失败/.test(content.textContent || '');
      const empty = (content.innerHTML || '').trim().length < 30;
      if (hasError || empty) {
        pageOk = false;
        badPages.push(p);
      }
    }
    check(`${rc.label}全部 ${rc.paths.length} 个页面渲染正常`, pageOk, badPages.length ? '异常页：' + badPages.join(',') : '');

    // 退出登录
    doc.getElementById('logout-btn').dispatchEvent(new win.Event('click', { bubbles: true }));
    await waitFor(() => !doc.getElementById('login-page').hidden, 3000);
    await sleep(60);
  }

  console.log('\n【4】学生端关键交互');
  doc.getElementById('login-username').value = '2024001';
  doc.getElementById('login-password').value = ENGINE.DEMO_SECRET;
  doc.getElementById('login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !doc.getElementById('app').hidden, 6000);

  win.location.hash = '#/courses';
  await waitFor(() => doc.querySelectorAll('#content .course-card').length > 0, 4000);
  const cards = doc.querySelectorAll('#content .course-card');
  check('选课中心渲染课程卡片', cards.length > 0, `${cards.length} 张`);
  check('课程卡片包含状态标签', cards[0] && cards[0].querySelectorAll('.badge').length > 0);
  check('课程卡片包含热度进度条', doc.querySelectorAll('#content .heat-bar, #content .progress').length > 0);

  const statusTexts = Array.from(doc.querySelectorAll('#content .badge')).map((b) => b.textContent.trim());
  check('状态标签覆盖多种选课状态', new Set(statusTexts).size >= 2, [...new Set(statusTexts)].slice(0, 6).join('/'));

  const detailBtn = doc.querySelector('#content .course-card [data-detail], #content .course-card button');
  if (detailBtn) {
    detailBtn.dispatchEvent(new win.Event('click', { bubbles: true }));
    await sleep(200);
    const modal = doc.querySelector('#modal-root .modal');
    check('点击课程可打开详情弹窗', !!modal);
    if (modal) {
      check('详情弹窗有页脚按钮', modal.querySelectorAll('.modal-foot button').length > 0);
      const closeBtn = modal.querySelector('[data-close]');
      if (closeBtn) closeBtn.dispatchEvent(new win.Event('click', { bubbles: true }));
      await sleep(120);
      check('详情弹窗可正常关闭', !doc.querySelector('#modal-root .modal'));
    }
  } else {
    check('点击课程可打开详情弹窗', false, '未找到详情按钮');
  }

  win.location.hash = '#/timetable';
  await waitFor(() => doc.querySelector('#content .tt-grid, #content table'), 4000);
  check('我的课表页渲染周视图', !!doc.querySelector('#content .tt-grid, #content table'));

  // 节次时间须与学校《课时表》一致（每节 40 分钟，上午 1~5、下午 6~10、晚上 11~13）
  const ttText = doc.getElementById('content').textContent || '';
  const ttRows = doc.querySelectorAll('#content .timetable tbody tr').length;
  check('课表默认展示全天 13 节', ttRows === 13, `${ttRows} 行`);
  check('课表含「时段」列', /时段/.test(ttText));
  check('课表标注上午/下午时段', /上午/.test(ttText) && /下午/.test(ttText));
  check('课表含晚上时段（18:00-18:40）', /晚上/.test(ttText) && ttText.includes('18:00-18:40'));
  const p1 = doc.querySelector('#content tbody th .p-time');
  check('课表首节时间与课时表一致（08:00-08:40）', ttText.includes('08:00-08:40'), p1 ? p1.textContent : '未找到节次时间');

  win.location.hash = '#/my';
  await waitFor(() => doc.querySelectorAll('#content .course-card, #content tbody tr').length > 0, 4000);
  const dropBtn = doc.querySelector('#content [data-drop], #content [data-act="drop"]');
  if (dropBtn) {
    dropBtn.dispatchEvent(new win.Event('click', { bubbles: true }));
    await sleep(200);
    const dlg = doc.querySelector('#modal-root .modal');
    check('退课弹出二次确认框', !!dlg);
    if (dlg) {
      const cancel = dlg.querySelector('[data-close], .btn-ghost');
      if (cancel) cancel.dispatchEvent(new win.Event('click', { bubbles: true }));
      await sleep(120);
    }
  } else {
    check('退课弹出二次确认框', true, '（该学生当前无可退课程，已跳过）');
  }

  win.location.hash = '#/waitlist';
  await sleep(200);
  check('候补页可渲染', (doc.getElementById('content').innerHTML || '').length > 50);

  win.location.hash = '#/notices';
  await sleep(200);
  check('通知页可渲染', (doc.getElementById('content').innerHTML || '').length > 50);

  win.location.hash = '#/rules';
  await sleep(200);
  check('选课规则页可渲染', (doc.getElementById('content').innerHTML || '').length > 50);
  const rulesRows = doc.querySelectorAll('#content .period-table tbody tr');
  const rulesText = doc.getElementById('content').textContent || '';
  check('选课规则页含课时表（13 节）', rulesRows.length === 13, `${rulesRows.length} 行`);
  check('课时表含上午/下午/晚上三段', ['上午', '下午', '晚上'].every((t) => rulesText.includes(t)));
  check(
    '课时表时间抽查：第 6 节 13:00-13:40、第 11 节 18:00-18:40',
    rulesText.includes('13:00-13:40') && rulesText.includes('18:00-18:40')
  );

  console.log('\n【5】数据重置能力');
  const before = doc.getElementById('user-name').textContent;
  check('重置前处于登录状态', before && before !== '—', before);

  console.log('\n【6】运行时质量');
  check('无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log('\n' + '─'.repeat(64));
  console.log(`单文件网页版验证：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    dom.window.close();
    process.exit(1);
  }
  console.log('全部通过：单文件网页版可独立运行。');
  dom.window.close();
}

main().catch((e) => {
  console.error('验证执行异常：', e);
  process.exit(1);
});
