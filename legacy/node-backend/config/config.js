'use strict';

/**
 * 统一配置。所有可变参数均可通过环境变量注入，不硬编码在业务代码中（见设计文档 10.1）。
 */

const fs = require('fs');
const path = require('path');

/**
 * 零依赖加载项目根目录下的 .env（存在才读）。
 * 已存在的真实环境变量优先、不被文件覆盖，因此生产环境用 pm2 / systemd / 容器注入时行为不变。
 */
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const s = line.trim();
      if (!s || s.charAt(0) === '#') return;
      const i = s.indexOf('=');
      if (i < 1) return;
      const key = s.slice(0, i).trim();
      let val = s.slice(i + 1).trim();
      const quoted =
        (val.charAt(0) === '"' && val.slice(-1) === '"') ||
        (val.charAt(0) === "'" && val.slice(-1) === "'");
      if (quoted) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    });
})();

function env(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(key, fallback) {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) ? v : fallback;
}

module.exports = {
  server: {
    port: envInt('PORT', 3000),
    host: env('HOST', '127.0.0.1'),
  },

  /**
   * 跨域白名单（前后端分离架构，见 README 第 1 节）。
   * 留空或填 * 表示放行任意来源，适合开发与公开演示；
   * 生产环境建议填前端实际地址，例如：https://course.example.com,http://1.2.3.4
   */
  cors: {
    origins: env('CORS_ORIGINS', '*'),
  },

  db: {
    host: env('DB_HOST', '127.0.0.1'),
    port: envInt('DB_PORT', 3306),
    user: env('DB_USER', 'root'),
    // 数据库口令一律通过 DB_PASSWORD 环境变量或项目根目录的 .env 提供，
    // 源码中不留任何默认口令，避免随代码一起外发（见设计文档 10.1 安全要求）。
    password: env('DB_PASSWORD', ''),
    database: env('DB_NAME', 'course_selection'),
    connectionLimit: envInt('DB_POOL', 10),
    charset: 'utf8mb4',
  },

  auth: {
    // 会话令牌签名密钥，生产环境务必通过环境变量覆盖
    secret: env('AUTH_SECRET', 'course-selection-demo-secret-2026'),
    // 空闲超时（分钟），见设计文档 2.4 与 7.3
    idleTimeoutMinutes: envInt('AUTH_IDLE_MINUTES', 30),
    // 登录连续失败触发验证码的次数（见 3.2.1）
    captchaAfterFailures: envInt('AUTH_CAPTCHA_AFTER', 5),
  },

  // 防脚本刷课限速阈值（见 4.5、表 7）
  rateLimit: {
    windowSeconds: envInt('RL_WINDOW_SECONDS', 60),
    softLimit: envInt('RL_SOFT_LIMIT', 10), // 超过触发限速
    hardLimit: envInt('RL_HARD_LIMIT', 20), // 超过要求验证码
  },

  // 幂等请求去重缓存时长（分钟），见设计文档 2.4
  idempotencyTtlMinutes: envInt('IDEMPOTENCY_TTL_MINUTES', 5),

  business: {
    // 候补递补确认期（小时），见 4.6
    waitlistConfirmHours: envInt('WAITLIST_CONFIRM_HOURS', 24),
    // 退课截止：补退选批次结束后的第 N 天 23:59（空则回落到补退选批次截止时间）
    dropDeadlineDaysAfterBatch: envInt('DROP_DEADLINE_DAYS', 7),
  },
};
