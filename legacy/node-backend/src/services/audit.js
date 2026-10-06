'use strict';

/**
 * 审计日志服务（见设计文档 2.3、7.3）：
 * 关键操作写入审计日志，含操作人、IP、结果与失败原因；日志保留 180 天。
 */

const db = require('../db');

async function log(req, { action, targetType = null, targetId = null, result = 1, detail = null }) {
  const user = req && req.user ? req.user : null;
  const ip = (req && req.clientIp) || (req && req.ip) || null;
  try {
    await db.execute(
      `INSERT INTO t_audit_log (user_id, username, action, target_type, target_id, ip, result, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user ? user.userId : null,
        user ? user.username : null,
        action,
        targetType,
        targetId,
        ip,
        result,
        detail ? String(detail).slice(0, 500) : null,
      ]
    );
  } catch (err) {
    // 审计写入失败不应中断业务
    // eslint-disable-next-line no-console
    console.error('[AUDIT-FAIL]', action, err.message);
  }
}

module.exports = { log };
