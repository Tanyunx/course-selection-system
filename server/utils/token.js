'use strict';

/**
 * 会话令牌：HMAC-SHA256 签名的自包含令牌（JWT 简化实现，无第三方依赖）。
 * 载荷含 userId / role / 签发与过期时间，服务端另存会话记录以便注销与空闲超时。
 */

const crypto = require('crypto');
const config = require('../../config/config');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (str) =>
  Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function sign(payload, ttlMinutes) {
  const now = Date.now();
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlMinutes * 60 * 1000,
    jti: crypto.randomUUID(),
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', config.auth.secret).update(`${head}.${data}`).digest());
  return { token: `${head}.${data}.${sig}`, payload: body };
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, data, sig] = parts;
  const expect = b64url(crypto.createHmac('sha256', config.auth.secret).update(`${head}.${data}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(unb64url(data));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

module.exports = { sign, verify };
