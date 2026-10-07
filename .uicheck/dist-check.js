'use strict';

/**
 * 分发包一致性验证（distribution integrity）
 *
 * 与另外两个前端脚本的分工，避免重复：
 *   - ui-check.js      ：前后端分离那一路——真实浏览器环境 + 真后端 + 真 PostgreSQL，53 项
 *   - static-check.js  ：单文件版的界面深度覆盖——四角色全页面、菜单权限矩阵、弹窗、课时表，51 项
 *   - 本脚本（唯一职责）：**两份分发副本是否同步、是否真自包含、能否独立起来**
 *
 * 为什么要单独校验「同步」：
 *   同一份单文件产物会被写成两个文件——
 *     ① 选课系统-单文件版.html  给本地双击 / 发给同学
 *     ② docs/index.html          GitHub Pages 站点入口
 *   它们由 tools/build.js 一次构建同时写出，但只要有人只改了其中一个，
 *   线上页面就会和本地演示不一致，而两边的功能测试都还是绿的——这种漂移极难发现。
 *   所以这里直接用字节比对把「必须一致」这条钉死。
 *
 * 运行：cd .uicheck && node dist-check.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, '选课系统-单文件版.html');
const PUB = path.join(ROOT, 'docs', 'index.html');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  [通过] ${name}`);
  } else {
    fail++;
    console.log(`  [失败] ${name}${extra ? '  -> ' + extra : ''}`);
  }
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function extractInlineScript(html) {
  const m = html.match(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/);
  return m ? m[0].replace(/^<script>/, '').replace(/<\/script>$/, '') : null;
}

(async () => {
  console.log('\n===== ① 两份分发副本是否同步 =====');

  ok('选课系统-单文件版.html 存在', fs.existsSync(SRC), SRC);
  ok('docs/index.html 存在', fs.existsSync(PUB), PUB);
  if (!fs.existsSync(SRC) || !fs.existsSync(PUB)) {
    console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
    process.exit(1);
  }

  const a = fs.readFileSync(SRC);
  const b = fs.readFileSync(PUB);
  console.log(`  本地版 ${(a.length / 1024).toFixed(1)} KB  sha256:${sha(a)}`);
  console.log(`  线上版 ${(b.length / 1024).toFixed(1)} KB  sha256:${sha(b)}`);
  ok('两份内容完全一致（字节级）', a.equals(b), a.equals(b) ? '' : '内容已漂移，请重跑 node tools/build.js');

  const html = a.toString('utf8');

  console.log('\n===== ② 是否真自包含（零外部依赖） =====');
  const extScript = html.match(/<script[^>]*\ssrc=/gi) || [];
  const extLink = html.match(/<link[^>]*\shref=["'](?!data:)[^"']+["']/gi) || [];
  const anyUrl = html.match(/(?:src|href)\s*=\s*["']https?:\/\//gi) || [];
  ok('无外部 <script src>', extScript.length === 0, `${extScript.length} 处`);
  ok('无外部 <link href>（data: 图标除外）', extLink.length === 0, `${extLink.length} 处`);
  ok('无任何绝对 URL 资源引用', anyUrl.length === 0, anyUrl.slice(0, 3).join(', '));
  ok('样式已内联', html.includes('<style>'));
  ok('未残留模块入口 js/app.js', !html.includes('js/app.js'));

  console.log('\n===== ③ 产物结构与构建一致 =====');
  const code = extractInlineScript(html);
  ok('内联脚本存在且为单一 IIFE', !!code);
  if (code) {
    try {
      new Function(code);
      ok('内联脚本语法可解析', true);
    } catch (e) {
      ok('内联脚本语法可解析', false, e.message);
    }
  }
  ok('注入了演示提示条样式 .static-bar', html.includes('.static-bar'));
  ok('内联了业务引擎（含路由表）', /const ENGINE = \(function \(\)/.test(html));
  ok('未包含工程内的绝对路径', !/C:\\\\Users|C:\/Users|\/c\/Users/.test(html));

  console.log('\n===== ④ 能否独立启动（无后端、无网络） =====');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e && e.message)));
  vc.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    virtualConsole: vc,
  });
  const { window } = dom;
  const doc = window.document;
  await wait(400);

  ok('加载无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  ok('登录页已渲染', !!doc.querySelector('#login-page'));

  // 走真实事件链登录一次，确认离线引擎确实在算而不是空壳
  const u = doc.querySelector('#login-username');
  const p = doc.querySelector('#login-password');
  const form = doc.querySelector('#login-form');
  ok('登录表单元素齐全', !!u && !!p && !!form);

  if (u && p && form) {
    u.value = '2024001';
    p.value = '123456';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await wait(900);

    const err = doc.querySelector('#login-error');
    ok('离线登录成功', err && err.hidden === true, err && err.textContent);
    ok('已进入主界面', doc.querySelector('#app').hidden === false);
    const content = doc.querySelector('#content');
    ok('主内容区已渲染', content && content.querySelectorAll('*').length > 20);
  }

  ok('全程无 console.error / jsdomError', errors.length === 0, errors.slice(0, 3).join(' | '));

  window.close();

  console.log(`\n===== 分发包一致性：通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail === 0 ? 0 : 1);
})();
