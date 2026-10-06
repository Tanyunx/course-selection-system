'use strict';

/**
 * 防脚本刷课限速（见设计文档 4.5 与表 7）：
 * 同一账号在时间窗口内超过软阈值触发限速，超过硬阈值要求完成图形验证码。
 * 仅作用于选课等写操作，读操作不受影响。
 */

const config = require('../../config/config');

const buckets = new Map(); // userId -> number[]（请求时间戳）
const verified = new Map(); // userId -> 验证码通过时间

function prune(list, now) {
  const win = config.rateLimit.windowSeconds * 1000;
  while (list.length && now - list[0] > win) list.shift();
}

/**
 * @returns {{limited:boolean, needCaptcha:boolean, count:number, retryAfter:number}}
 */
function check(userId) {
  const now = Date.now();
  const list = buckets.get(userId) || [];
  prune(list, now);
  list.push(now);
  buckets.set(userId, list);

  const win = config.rateLimit.windowSeconds * 1000;
  const lastVerified = verified.get(userId) || 0;
  const captchaOk = now - lastVerified < win;

  const needCaptcha = list.length > config.rateLimit.hardLimit && !captchaOk;
  const limited = list.length > config.rateLimit.softLimit && !captchaOk;

  let retryAfter = 0;
  if (limited && list.length) retryAfter = Math.ceil((win - (now - list[0])) / 1000);

  return { limited, needCaptcha, count: list.length, retryAfter };
}

/** 前端完成图形验证码后调用，窗口内免除限速 */
function markCaptchaPassed(userId) {
  verified.set(userId, Date.now());
}

function reset(userId) {
  buckets.delete(userId);
  verified.delete(userId);
}

module.exports = { check, markCaptchaPassed, reset };
