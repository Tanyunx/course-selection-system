'use strict';

/**
 * 数据库初始化：执行建库建表脚本并导入种子数据。
 *   node scripts/init-db.js
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config/config');
const pwd = require('../server/utils/password');

const DEMO_PASSWORD = '123456';

function readSql(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'db', name), 'utf8');
}

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  console.log(`[1/3] 连接数据库 ${config.db.user}@${config.db.host}:${config.db.port} ... OK`);

  console.log('[2/3] 执行 db/schema.sql 建库建表 ...');
  await conn.query(readSql('schema.sql'));

  console.log('[3/3] 导入 db/seed.sql 种子数据 ...');
  const hash = pwd.hash(DEMO_PASSWORD).replace(/\$/g, '$$$$');
  const seed = readSql('seed.sql').replace(/__PWD_HASH__/g, hash);
  await conn.query(seed);

  await conn.changeUser({ database: config.db.database });
  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS t, TABLE_ROWS AS rows_count FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [config.db.database]
  );
  const [counts] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM t_user) AS users,
       (SELECT COUNT(*) FROM t_course) AS courses,
       (SELECT COUNT(*) FROM t_course_offering) AS offerings,
       (SELECT COUNT(*) FROM t_course_schedule) AS schedules,
       (SELECT COUNT(*) FROM t_enrollment WHERE status = 1) AS enrollments,
       (SELECT COUNT(*) FROM t_waitlist WHERE status = 1) AS waitlist`
  );

  console.log('');
  console.log(`数据库 ${config.db.database} 初始化完成，共 ${tables.length} 张表：`);
  console.log('  ' + tables.map((t) => t.t).join(', '));
  console.log('');
  console.log(
    `数据统计：用户 ${counts[0].users}｜课程 ${counts[0].courses}｜开课 ${counts[0].offerings}｜排课时段 ${counts[0].schedules}｜选课记录 ${counts[0].enrollments}｜候补 ${counts[0].waitlist}`
  );
  console.log('演示账号密码见 README.md 的「演示账号」一节。');
  console.log('');

  await conn.end();
}

main().catch((err) => {
  console.error('初始化失败：', err.message);
  process.exit(1);
});
