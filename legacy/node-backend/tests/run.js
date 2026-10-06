'use strict';

/**
 * 端到端测试入口：自动拉起后端服务 → 等健康检查通过 → 依次跑冒烟测试与验收测试 → 关闭服务。
 *
 * 用法：npm test
 * 说明：为避免与本机已在运行的开发实例（默认 3000 端口）冲突，测试默认使用 3101 端口，
 *      可用 TEST_PORT 环境变量覆盖。
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.TEST_PORT || '3101';
const BASE = `http://127.0.0.1:${PORT}`;

const line = (s) => process.stdout.write(s + '\n');

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const json = await res.json();
      if (json && json.data && json.data.status === 'UP') return { ok: true };
      lastErr = '健康检查返回 ' + JSON.stringify(json);
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, detail: lastErr };
}

function runNode(script, argv, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...(argv || [])], {
      cwd: ROOT,
      env: { ...process.env, ...(extraEnv || {}) },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}

(async () => {
  line('=== 前后端分离 · 后端接口端到端测试 ===');
  line(`服务端口：${PORT}（测试专用，不影响开发实例）`);
  line('');

  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'app.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT, HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d.toString()));

  let failed = false;
  try {
    const health = await waitForHealth();
    if (!health.ok) {
      line('✗ 后端服务未能启动，测试中止');
      if (health.detail) line('  原因：' + health.detail);
      line('  排查：确认数据库已启动、backend/.env 中的连接参数正确。');
      failed = true;
      return;
    }
    line(`✓ 服务已就绪：${BASE}\n`);

    line('--- 1/2 接口冒烟测试 ---');
    const smokeOk = await runNode('smoke.js', [BASE], { BASE_URL: BASE });
    if (!smokeOk) failed = true;
    line('');

    line('--- 2/2 端到端验收测试 ---');
    const acceptOk = await runNode('acceptance.js', [], { BASE_URL: BASE });
    if (!acceptOk) failed = true;
    line('');
  } catch (err) {
    line('测试执行异常：' + err.message);
    failed = true;
  } finally {
    server.kill();
  }

  line(failed ? '=== 测试未全部通过 ===' : '=== 全部测试通过 ===');
  process.exit(failed ? 1 : 0);
})();
