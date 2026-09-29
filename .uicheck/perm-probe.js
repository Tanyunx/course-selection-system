/**
 * 权限探针：验证「云服务器部署指南」第 5 步的授权写法是否足够支撑 npm run db:init。
 * 只在本地 MySQL 上创建临时库与临时账号，跑完即清理，不影响业务数据。
 */
const mysql = require('mysql2/promise');
const cfg = require('../config/config.js');

const DB = 'zz_perm_probe';
const USER = 'zz_probe';

// 口令不在源码中出现完整字面量，运行时拼装
const PWD = 'Zz' + 'Probe' + (Date.now() % 100000) + '!x';

const base = {
  host: cfg.db.host,
  port: cfg.db.port,
  user: cfg.db.user,
  password: cfg.db.password,
  multipleStatements: true,
};

async function main() {
  const root = await mysql.createConnection(base);

  await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await root.query(`DROP USER IF EXISTS '${USER}'@'localhost'`);

  // 模拟指南：先建库 + 建专用账号 + 库级授权
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  await root.query(`CREATE USER '${USER}'@'localhost' IDENTIFIED BY '${PWD}'`);
  await root.query(`GRANT ALL PRIVILEGES ON \`${DB}\`.* TO '${USER}'@'localhost'`);
  await root.query('FLUSH PRIVILEGES');
  console.log('[1] root 建库 + 专用账号 + 库级授权 ... OK');

  // ---- 用专用账号连接（验证 @localhost 能否匹配 TCP 连接）----
  let app;
  try {
    app = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: USER,
      password: PWD,
    });
    console.log('[2] 专用账号 TCP 连接 ... OK（@localhost 可匹配 127.0.0.1）');
  } catch (e) {
    console.log('[2] 专用账号 TCP 连接 ... 失败：', e.code, '|', e.message);
    await root.query(`DROP USER IF EXISTS '${USER}'@'localhost'`);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.end();
    return;
  }

  // ---- 关键：init-db 会执行 schema.sql 开头的 CREATE DATABASE IF NOT EXISTS ----
  try {
    await app.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
    console.log('[3] 专用账号执行 CREATE DATABASE IF NOT EXISTS ... 通过');
  } catch (e) {
    console.log('[3] 专用账号执行 CREATE DATABASE IF NOT EXISTS ... 被拒绝：', e.code, '|', e.message);
    console.log('    → 指南需要补充兜底：改用 root 跑一次 db:init');
  }

  // ---- init-db 用 changeUser 切库后的建表能力 ----
  try {
    await app.changeUser({ database: DB });
    await app.query('CREATE TABLE zz_t (id INT PRIMARY KEY)');
    await app.query('DROP TABLE zz_t');
    console.log('[4] 切库后建表 / 删表 ... 通过');
  } catch (e) {
    console.log('[4] 切库后建表 ... 失败：', e.code, '|', e.message);
  }

  await app.end();
  await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await root.query(`DROP USER IF EXISTS '${USER}'@'localhost'`);
  await root.query('FLUSH PRIVILEGES');
  await root.end();
  console.log('[5] 探针数据已清理');
}

main().catch((e) => {
  console.error('探针异常：', e.code || '', e.message);
  process.exit(1);
});
