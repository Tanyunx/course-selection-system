'use strict';

/**
 * 课表 / 课时表 视觉复核预览
 *
 * jsdom 不执行 CSS 布局，无法发现样式问题；这里把单文件版真实渲染出的
 * 「我的课表」与「课时表」两段 HTML 抠出来，配上构建产物里的真实样式，
 * 生成一个预览页，交给无头浏览器截图做视觉确认。
 *
 * 运行：node .uicheck/make-preview.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ENGINE = require('../web-build/mock/index.js');
const HTML_PATH = path.join(__dirname, '..', '选课系统-单文件版.html');
const OUT = path.join(__dirname, 'preview-timetable.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch (_) {
      /* 忽略中间态 */
    }
    await sleep(30);
  }
  return false;
}

async function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1/course-selection-system.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const { window: win } = dom;
  const doc = win.document;

  // 登录（口令来自内联引擎，避免在源码里出现字面量）
  await waitFor(() => doc.getElementById('login-username'));
  doc.getElementById('login-username').value = '2024001';
  doc.getElementById('login-password').value = ENGINE.DEMO_SECRET;
  doc.getElementById('login-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !doc.getElementById('app').hidden, 6000);

  win.location.hash = '#/timetable';
  await waitFor(() => doc.querySelector('#content .timetable'), 5000);
  const timetable = doc.getElementById('content').innerHTML;

  win.location.hash = '#/rules';
  await waitFor(() => doc.querySelector('#content .period-table'), 5000);
  const rules = doc.getElementById('content').innerHTML;
  const periodCard = (rules.match(/<div class="card">[\s\S]*?period-table[\s\S]*?<\/div>\s*<\/div>/) || [])[0] || rules;

  fs.writeFileSync(
    OUT,
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>课表与课时表预览</title>
<style>
${style}
body { padding: 20px; background: #fff; }
.wrap { max-width: 1180px; margin: 0 auto; }
h2.blk { font-size: 15px; margin: 22px 0 10px; color: #1f2937; }
</style>
</head>
<body>
<div class="wrap">
  <h2 class="blk">我的课表（时段 / 节次 / 时间）</h2>
  ${timetable}
  <h2 class="blk">课时表（选课规则页）</h2>
  ${periodCard}
</div>
</body>
</html>`,
    'utf8'
  );

  console.log('预览页已生成：', OUT);
  win.close();
}

main().catch((e) => {
  console.error('生成失败：', e && e.message ? e.message : e);
  process.exit(1);
});
