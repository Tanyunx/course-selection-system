'use strict';

/**
 * 写操作幂等缓存（见设计文档 2.4）：
 * 选课、退课、换课、候补等接口要求前端携带 requestId，
 * 服务端缓存 5 分钟并去重，重复请求直接返回首次结果。
 */

const config = require('../../config/config');

const ttl = config.idempotencyTtlMinutes * 60 * 1000;
const store = new Map(); // `${userId}:${requestId}` -> { at, result }

function key(userId, requestId) {
  return `${userId}:${requestId}`;
}

/** 命中缓存则返回已存结果，否则返回 null */
function hit(userId, requestId) {
  if (!requestId) return null;
  const item = store.get(key(userId, requestId));
  if (!item) return null;
  if (Date.now() - item.at > ttl) {
    store.delete(key(userId, requestId));
    return null;
  }
  return item.result;
}

/** 记录首次执行结果（含失败结果，保证重复提交返回一致） */
function save(userId, requestId, result) {
  if (!requestId) return;
  store.set(key(userId, requestId), { at: Date.now(), result });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) if (now - v.at > ttl) store.delete(k);
}, 60 * 1000).unref();

module.exports = { hit, save };
