'use strict';

/**
 * 服务端会话存储（内存实现）。
 * 设计文档 2.4 / 7.3：登录后签发令牌，令牌设置 30 分钟空闲超时，退出时失效。
 */

const config = require('../../config/config');

const sessions = new Map(); // jti -> { userId, username, realName, role, lastActive }

function create(payload) {
  sessions.set(payload.jti, {
    userId: payload.userId,
    username: payload.username,
    realName: payload.realName,
    role: payload.role,
    lastActive: Date.now(),
    loginAt: Date.now(),
  });
  return sessions.get(payload.jti);
}

function get(jti) {
  return sessions.get(jti) || null;
}

function touch(jti) {
  const s = sessions.get(jti);
  if (s) s.lastActive = Date.now();
  return s;
}

function destroy(jti) {
  return sessions.delete(jti);
}

function isIdle(jti) {
  const s = sessions.get(jti);
  if (!s) return true;
  return Date.now() - s.lastActive > config.auth.idleTimeoutMinutes * 60 * 1000;
}

/** 在线人数（用于运行监控页） */
function onlineCount() {
  const now = Date.now();
  const ttl = config.auth.idleTimeoutMinutes * 60 * 1000;
  let n = 0;
  for (const s of sessions.values()) if (now - s.lastActive <= ttl) n += 1;
  return n;
}

/** 定期清理过期会话，避免内存泄漏 */
setInterval(() => {
  const now = Date.now();
  const ttl = config.auth.idleTimeoutMinutes * 60 * 1000;
  for (const [k, s] of sessions.entries()) if (now - s.lastActive > ttl) sessions.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = { create, get, touch, destroy, isIdle, onlineCount };
