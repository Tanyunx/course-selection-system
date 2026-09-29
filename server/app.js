'use strict';

/**
 * 应用入口（见设计文档 2.1 三层架构、2.4 接口设计）。
 */

const path = require('path');
const express = require('express');
const config = require('../config/config');
const db = require('./db');
const metrics = require('./store/metrics');
const { fail } = require('./utils/response');
const { CODES } = require('./utils/errors');

const app = express();

app.disable('x-powered-by');
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

/* ---------------- 静态资源 ---------------- */
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
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
    console.log('  在线选课系统已启动');
    console.log(`  访问地址：http://${config.server.host}:${config.server.port}`);
    console.log(`  数据库  ：${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
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
