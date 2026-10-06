'use strict';

/**
 * 应用入口（见设计文档 2.1 三层架构、2.4 接口设计）。
 */

const express = require('express');
const config = require('../config/config');
const db = require('./db');
const metrics = require('./store/metrics');
const { fail } = require('./utils/response');
const { CODES } = require('./utils/errors');

const app = express();

app.disable('x-powered-by');

/**
 * 跨域（前后端分离的核心配置）：前端是独立工程，部署在另一来源（开发时 Vite dev server、
 * 生产时 Nginx 静态站点），浏览器会发起跨源请求，因此必须显式放行。
 * 白名单通过 CORS_ORIGINS 配置，默认为 *（本项目用 Bearer 令牌鉴权、不依赖 Cookie，
 * 因此不需要 Access-Control-Allow-Credentials）。
 */
const CORS_ORIGINS = String(config.cors.origins)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CORS_ALLOW_ALL = CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes('*');

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (CORS_ALLOW_ALL) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

/** 请求指标采集：包装 res.json 以捕获统一返回体中的错误码 */
app.use((req, res, next) => {
  const started = Date.now();
  const original = res.json.bind(res);
  res.json = (body) => {
    const code = body && typeof body.code === 'number' ? body.code : 0;
    metrics.record(req, req.baseUrl && req.route ? req.baseUrl + req.route.path : req.path, code, Date.now() - started);
    return original(body);
  };
  next();
});

/** 基础安全响应头 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/** 健康检查 */
app.get('/api/health', async (req, res) => {
  try {
    await db.ping();
    res.json({ code: 0, message: '操作成功', data: { status: 'UP', time: new Date().toISOString() } });
  } catch (err) {
    res.json({ code: CODES.INTERNAL_ERROR, message: '数据库不可用', data: { status: 'DOWN', detail: err.message } });
  }
});

/* ---------------- 业务路由 ---------------- */
// 注意顺序：系统管理端 /admin/users、/admin/audit-logs、/admin/monitor 需先于教务端匹配
app.use('/api', require('./routes/sys'));
app.use('/api', require('./routes/admin'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/courses'));
app.use('/api', require('./routes/enrollments'));
app.use('/api', require('./routes/waitlist'));
app.use('/api', require('./routes/notices'));
app.use('/api', require('./routes/teacher'));

/** 未匹配的接口统一返回 9002 */
app.use('/api', (req, res) => {
  fail(res, CODES.BAD_REQUEST, `接口不存在：${req.method} ${req.originalUrl}`, null, 404);
});

/* ---------------- 服务根路径说明 ----------------
 * 前后端分离：本服务只提供 /api 接口，不托管任何页面。
 * 前端为独立工程（frontend/），开发时由 Vite dev server 提供页面并代理 /api，
 * 生产时由 Nginx 托管前端构建产物并把 /api 反向代理到本服务。 */
app.get('/', (req, res) => {
  res.json({
    code: 0,
    message: '操作成功',
    data: {
      service: '在线选课系统 后端 API',
      version: '3.0.0',
      apiBase: '/api',
      health: '/api/health',
      docs: '接口清单见项目 README.md 第 2 节',
      hint: '页面由独立部署的前端工程提供，本服务不返回 HTML',
    },
  });
});

/* ---------------- 兜底错误处理 ---------------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[ERROR]', err);
  if (res.headersSent) return;
  fail(res, CODES.INTERNAL_ERROR, undefined, {
    detail: process.env.NODE_ENV === 'production' ? undefined : String(err.message || err),
  });
});

/* ---------------- 启动 ---------------- */
async function bootstrap() {
  try {
    await db.ping();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('\n[启动失败] 无法连接数据库，请检查 config/config.js 或 .env 配置。');
    console.error('  错误信息：', err.message, '\n');
    process.exit(1);
  }

  // 候补递补确认超时回收（4.6 第 5 条），每分钟扫描一次
  const waitlist = require('./services/waitlistService');
  setInterval(() => {
    waitlist.sweepExpired().catch((e) => console.error('[SWEEP]', e.message));
  }, 60 * 1000).unref();

  app.listen(config.server.port, config.server.host, () => {
    // eslint-disable-next-line no-console
    console.log('');
    console.log('  在线选课系统 · 后端 API 服务已启动');
    console.log(`  接口地址：http://${config.server.host}:${config.server.port}/api`);
    console.log(`  健康检查：http://${config.server.host}:${config.server.port}/api/health`);
    console.log(`  数据库  ：${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
    console.log(`  跨域白名单：${config.cors.origins}`);
    console.log('');
    console.log('  注意：本服务只提供接口，不返回页面。页面请启动前端工程 frontend（npm run dev）。');
    console.log('');
    console.log('  演示账号（登录口令见 README.md 的「演示账号」一节）：');
    console.log('    学生      2024001 / 2024002 / 2023001 / 2025001');
    console.log('    教师      teacher001 / teacher002');
    console.log('    教务管理  academic');
    console.log('    系统管理  sysadmin');
    console.log('');
  });
}

if (require.main === module) {
  bootstrap();
}

module.exports = app;
