'use strict';

/**
 * 从本机 MySQL 导出全部 18 张表的种子数据，生成静态版可直接内嵌的 JSON。
 *
 * 用途：让「免安装单文件网页版」与数据库版共享同一份真实数据，
 * 避免手工重写种子数据造成两边不一致。
 *
 * 运行：node web-build/export-data.js
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config/config');

const TABLES = [
  't_term',
  't_user',
  't_student',
  't_teacher',
  't_course_category',
  't_course',
  't_course_prereq',
  't_course_offering',
  't_course_schedule',
  't_enrollment',
  't_waitlist',
  't_enroll_batch',
  't_credit_rule',
  't_category_credit_rule',
  't_student_course_history',
  't_notice',
  't_announcement',
  't_audit_log',
];

/** MySQL 的 DECIMAL 经 mysql2 返回为字符串，这里统一转为数字，避免前端出现 '3.0' 之类的字符串运算 */
const DECIMAL_FIELDS = new Set(['credit', 'min_credit', 'max_credit', 'score']);

/** 时间统一输出为 'YYYY-MM-DD HH:mm:ss'，与后端写入数据库的格式保持一致 */
function normalize(k, v) {
  if (v === null || v === undefined) return v;
  if (DECIMAL_FIELDS.has(k) && !(v instanceof Date)) return Number(v);
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(
      v.getMinutes()
    )}:${p(v.getSeconds())}`;
  }
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return v;
}

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: config.db.charset,
    dateStrings: true, // 关键：直接取字符串，避免时区换算导致时间偏移
  });

  const out = {};
  const stats = [];

  for (const t of TABLES) {
    let rows;
    try {
      const [r] = await conn.query(`SELECT * FROM \`${t}\` ORDER BY id`);
      rows = r;
    } catch (e) {
      rows = [];
    }
    rows = rows.map((row) => {
      const o = {};
      Object.keys(row).forEach((k) => {
        // 密码哈希不下发到前端：静态版使用演示口令直通校验
        if (k === 'password_hash') return;
        o[k] = normalize(k, row[k]);
      });
      return o;
    });
    out[t] = rows;
    stats.push(`${t}: ${rows.length}`);
  }

  await conn.end();

  // 额外产出：用当前真实时间评估的批次与学期状态，便于排查「为什么选不了课」
  const nowStr = normalize(new Date());
  const batches = out.t_enroll_batch.map((b) => ({
    name: b.name,
    type: b.type,
    start: b.start_time,
    end: b.end_time,
    inWindow: nowStr >= b.start_time && nowStr <= b.end_time,
    targetGrade: b.target_grade,
  }));

  const target = path.join(__dirname, 'mock', 'data.js');
  const banner = `'use strict';\n\n/**\n * 由 web-build/export-data.js 自动生成，请勿手工修改。\n * 来源：本机 MySQL course_selection 库（与数据库版完全同源）。\n * 导出时间：${nowStr}\n */\n\n`;
  fs.writeFileSync(target, banner + 'const DATA = ' + JSON.stringify(out, null, 0) + ';\n\nmodule.exports = DATA;\n', 'utf8');

  console.log('导出完成 ->', target);
  console.log(stats.join('\n'));
  console.log('\n当前时间：', nowStr);
  console.log('批次窗口状态：');
  batches.forEach((b) => {
    console.log(
      `  ${b.name} [${b.type === 2 ? '补退选' : '正常选课'}] ${b.start} ~ ${b.end} => ${
        b.inWindow ? '进行中' : '不在窗口'
      }${b.targetGrade ? ' 年级=' + b.targetGrade : ''}`
    );
  });
}

main().catch((e) => {
  console.error('导出失败：', e.message);
  process.exit(1);
});
