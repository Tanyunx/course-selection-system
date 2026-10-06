'use strict';

/**
 * 通知服务（见设计文档 2.3 通知中心）。
 * 线程内直接写库；真实高并发场景下可替换为消息队列异步投递。
 */

const db = require('../db');

const TYPE = {
  ENROLL_RESULT: 1, // 选课结果
  WAITLIST_PROMOTED: 2, // 候补递补
  WAITLIST_FAILED: 3, // 递补失败
  DROP_RESULT: 4, // 退课
  ANNOUNCEMENT: 5, // 公告
};

async function send(userId, type, title, content, relatedId = null, conn = null) {
  const sql = `INSERT INTO t_notice (user_id, type, title, content, related_id, is_read)
               VALUES (?, ?, ?, ?, ?, 0)`;
  const params = [userId, type, String(title).slice(0, 100), String(content).slice(0, 500), relatedId];
  if (conn) await conn.query(sql, params);
  else await db.execute(sql, params);
}

module.exports = { TYPE, send };
