'use strict';

/**
 * 单文件网页版构建脚本
 *
 * 把「前端页面 + 前端模块 + 内嵌数据 + 业务规则引擎」全部内联进一个 .html 文件，
 * 产出双击即可运行、无需 Node、无需 MySQL、无需任何安装的网页。
 *
 * 处理要点：
 *  1. 种子数据来自 web-build/mock/data.js（由 export-data.js 从本机 MySQL 导出，与数据库版同源）；
 *  2. 业务规则引擎（core/rules/services/routes）包进 IIFE，仅暴露 ENGINE，避免与页面变量重名；
 *  3. 前端各页面模块同样是 ES Module，构建时去掉 import/export，
 *     并把 `import * as xxx` 还原为命名空间对象，使模块化写法在单文件里继续可用；
 *  4. api.js 的网络请求函数替换为直接调用本地引擎，页面代码一行不改。
 *
 * 运行：node web-build/build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOCK = path.join(__dirname, 'mock');
const PUBLIC = path.join(ROOT, 'public');

const read = (p) => fs.readFileSync(p, 'utf8');

/* ------------------------------------------------------------------ */
/* 源码变换工具                                                        */
/* ------------------------------------------------------------------ */

/** 去掉 ES Module 的 import / export 语法，保留实现代码 */
function stripModule(src) {
  return src
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?[^\S\n]*\n/gm, '')
    .replace(/^import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]+['"];?[^\S\n]*\n/gm, '')
    .replace(/^import\s+[\w{},\s*]+\s+from\s+['"][^'"]+['"];?[^\S\n]*\n/gm, '')
    .replace(/^import\s+['"][^'"]+['"];?[^\S\n]*\n/gm, '')
    .replace(/^export\s+default\s+/gm, '')
    .replace(/^export\s+(async\s+function|function|class|const|let|var)\b/gm, '$1')
    .replace(/^export\s*\{[\s\S]*?\};?[^\S\n]*\n/gm, '');
}

/** 收集一个模块对外暴露的名字，用于还原命名空间导入 */
function collectExports(src) {
  const names = [];
  let m;
  const re1 = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = re1.exec(src)) !== null) names.push(m[1]);
  const re2 = /^export\s*\{([^}]*)\}/gm;
  while ((m = re2.exec(src)) !== null) {
    m[1].split(',').forEach((part) => {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.push(n);
    });
  }
  return [...new Set(names)];
}

/** 删除 CommonJS 的 module.exports 块 */
function stripCommonJs(src) {
  const i = src.indexOf('module.exports');
  if (i < 0) return src;
  const j = src.indexOf('};', i);
  if (j < 0) {
    const k = src.indexOf('\n', i);
    return src.slice(0, i) + (k < 0 ? '' : src.slice(k + 1));
  }
  return src.slice(0, i) + src.slice(j + 2);
}

/** 把某个模块包成 IIFE，并返回其命名空间对象 */
function wrapModule(src, exportNames, constName) {
  return (
    `const ${constName} = (function () {\n` +
    stripModule(src) +
    `\nreturn { ${exportNames.join(', ')} };\n})();\n`
  );
}

/* ------------------------------------------------------------------ */
/* 一、组装内嵌业务引擎                                                */
/* ------------------------------------------------------------------ */

function buildEngine() {
  const data = read(path.join(MOCK, 'data.js'))
    .replace(/^module\.exports\s*=\s*DATA;\s*$/m, '')
    .trim();

  const core = stripCommonJs(read(path.join(MOCK, 'core.js')));
  const rules = stripCommonJs(read(path.join(MOCK, 'rules.js')));
  const services = stripCommonJs(read(path.join(MOCK, 'services.js')));
  const routes = stripCommonJs(read(path.join(MOCK, 'routes.js')));

  return [
    '/* ================= 内嵌业务引擎（与数据库版同源） ================= */',
    'const ENGINE = (function () {',
    data,
    core,
    rules,
    services,
    routes,
    'return { handle, resetData, CODES, MESSAGES, AppError, ROLE, DEMO_SECRET, ROUTES };',
    '})();',
  ].join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 二、组装前端模块                                                    */
/* ------------------------------------------------------------------ */

/** api.js：保留错误码表与令牌管理，只把网络请求换成调用本地引擎 */
function buildApi() {
  const src = read(path.join(PUBLIC, 'js', 'api.js'));
  const localRequest = `async function request(method, path, { body, query } = {}) {
  const res = await ENGINE.handle(method, path, query || {}, body, getToken());
  if (!res || typeof res.code !== 'number') throw new ApiError(9002, '本地引擎返回格式异常');
  if (res.code !== 0) {
    if (res.code === 1002) {
      setToken('');
      window.dispatchEvent(new CustomEvent('cs:unauthorized'));
    }
    throw new ApiError(res.code, res.message, res.data);
  }
  return res.data;
}`;

  const re = /async function request\(method, path, \{ body, query \} = \{\}\) \{[\s\S]*?\n\}/;
  if (!re.test(src)) throw new Error('api.js 结构已变化，未找到 request 函数，构建中止');
  // 注意：替换串必须用函数形式，否则源码中的 $$ / $& 等会被当作替换模式转义
  const replaced = src.replace(re, () => localRequest);
  return stripModule(replaced);
}

function buildFrontend() {
  const dir = path.join(PUBLIC, 'js');
  const parts = [];

  parts.push('/* ================= 前端界面层 ================= */');
  parts.push(stripModule(read(path.join(dir, 'ui.js'))));
  parts.push(buildApi());
  parts.push(stripModule(read(path.join(dir, 'scheduleEditor.js'))));

  // 四个页面模块各自独立作用域：它们存在同名导出（如 renderCourses），必须隔离
  ['student', 'teacher', 'admin', 'sys'].forEach((name) => {
    const src = read(path.join(dir, 'views', `${name}.js`));
    parts.push(wrapModule(src, collectExports(src), name));
  });

  parts.push(stripModule(read(path.join(dir, 'app.js'))));
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 三、静态版补充脚本（演示提示与数据重置）                            */
/* ------------------------------------------------------------------ */

function buildExtras() {
  return `
/* ================= 单文件演示版补充（提示条与数据重置） ================= */
(function () {
  var tip = document.querySelector('.demo-title');
  if (tip) tip.textContent = '演示账号（点击直接填入）· 统一口令：' + ENGINE.DEMO_SECRET;

  var bar = document.createElement('div');
  bar.className = 'static-bar';
  bar.innerHTML =
    '<span class="static-bar-text">单文件演示版 · 数据保存在浏览器内存中，刷新页面即恢复初始状态</span>' +
    '<button type="button" class="btn btn-ghost static-bar-btn">重置演示数据</button>';
  document.body.appendChild(bar);
  bar.querySelector('button').addEventListener('click', function () {
    if (confirm('确定重置为初始演示数据吗？当前的选课、退课与候补记录都会恢复原状。')) {
      ENGINE.resetData();
      window.location.reload();
    }
  });
})();
`;
}

/* ------------------------------------------------------------------ */
/* 四、组装 HTML                                                       */
/* ------------------------------------------------------------------ */

function buildHtml(engine, frontend, extras) {
  let html = read(path.join(PUBLIC, 'index.html'));
  const css = read(path.join(PUBLIC, 'css', 'app.css'));

  const staticCss = `
/* 单文件演示版补充样式 */
.static-bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 16px; font-size: 12px; line-height: 1.5;
  color: var(--text-2, #475569);
  background: rgba(255, 255, 255, 0.94);
  border-top: 1px solid var(--border, #e2e8f0);
  backdrop-filter: blur(6px);
}
.static-bar-text { flex: 1; }
.static-bar-btn { padding: 4px 12px; font-size: 12px; }
@media print { .static-bar { display: none; } }
`;

  // 内联样式与脚本一律使用函数式替换：源码中含 $ 序列（如 `$$`），
  // 若作为替换串会触发 String.replace 的特殊模式解释，导致代码被破坏
  html = html.replace(
    '<link rel="stylesheet" href="css/app.css" />',
    () => `<style>\n${css}\n${staticCss}\n</style>`
  );

  const script = `<script>\n(function () {\n'use strict';\n\n${engine}\n\n${frontend}\n${extras}\n})();\n</script>`;
  html = html.replace('<script type="module" src="js/app.js"></script>', () => script);

  if (html.includes('js/app.js')) throw new Error('入口脚本未被替换，构建中止');

  return html;
}

/* ------------------------------------------------------------------ */

function main() {
  const engine = buildEngine();
  const frontend = buildFrontend();
  const extras = buildExtras();
  const html = buildHtml(engine, frontend, extras);

  const out = path.join(ROOT, '选课系统-单文件版.html');
  fs.writeFileSync(out, html, 'utf8');

  // 同步产出可直接发布的静态站点目录。
  // 目录名固定为 docs/：GitHub Pages 原生支持「main 分支 + /docs 目录」作为站点根，
  // 无需额外配置 Action，因此这里不用 online/ 之类的自定义名。
  const siteDir = path.join(ROOT, 'docs');
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'index.html'), html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log('构建完成 ->', out);
  console.log('静态站点 ->', path.join(siteDir, 'index.html'));
  console.log(`文件大小：${kb} KB`);
  console.log(`内联模块：引擎 4 个（数据/规则/服务/路由） + 前端 8 个`);
}

main();
