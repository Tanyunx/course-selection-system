'use strict';

/**
 * 密码加盐哈希。使用 bcrypt 算法（bcryptjs 纯 JS 实现），
 * 数据库中只保存不可逆的哈希值，禁止明文或可逆加密（见设计文档 7.3）。
 */

const bcrypt = require('bcryptjs');

const ROUNDS = 10;

function hash(plain) {
  return bcrypt.hashSync(String(plain), ROUNDS);
}

function verify(plain, hashed) {
  if (!hashed) return false;
  try {
    return bcrypt.compareSync(String(plain), hashed);
  } catch (_) {
    return false;
  }
}

module.exports = { hash, verify };
