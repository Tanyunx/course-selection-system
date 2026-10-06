'use strict';

/**
 * 认证接口（见设计文档表 4 核心接口清单）。
 * 登录连续失败 5 次触发图形验证码（3.2.1）。
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../../config/config');
const pwd = require('../utils/password');
const tokenUtil = require('../utils/token');
const sessions = require('../store/sessionStore');
const account = require('../services/accountService');
const audit = require('../services/audit');
const { CODES, AppError } = require('../utils/errors');
const { ok, fail } = require('../utils/response');
const { authenticate, wrap } = require('../middleware/auth');

const router = express.Router();

const loginFailures = new Map(); // username -> count
const captchas = new Map(); // id -> { answer, expire }

function captchaNeeded(username) {
  return (loginFailures.get(username) || 0) >= config.auth.captchaAfterFailures;
}

/** 获取图形验证码（简易算式验证码，等价于图形验证码的可用性设计） */
router.get(
  '/captcha',
  wrap(async (req, res) => {
    const a = crypto.randomInt(2, 19);
    const b = crypto.randomInt(1, 9);
    const plus = crypto.randomInt(0, 2) === 1;
    const answer = plus ? a + b : a - b;
    const id = crypto.randomUUID();
    captchas.set(id, { answer, expire: Date.now() + 3 * 60 * 1000 });
    return ok(res, { captchaId: id, question: `${a} ${plus ? '+' : '−'} ${b} = ?` });
  })
);

/** 登录 */
router.post(
  '/login',
  wrap(async (req, res) => {
    const { username, password, captchaId, captchaAnswer } = req.body || {};
    if (!username || !password) throw new AppError(CODES.BAD_REQUEST, '请输入账号与密码');

    if (captchaNeeded(username)) {
      const item = captchaId ? captchas.get(captchaId) : null;
      const valid = item && item.expire > Date.now() && Number(captchaAnswer) === item.answer;
      if (captchaId) captchas.delete(captchaId);
      if (!valid) {
        return fail(res, CODES.AUTH_FAILED, '请输入正确的验证码', { needCaptcha: true });
      }
    }

    const user = await account.getUserByUsername(username);
    if (!user || !pwd.verify(password, user.password_hash)) {
      const c = (loginFailures.get(username) || 0) + 1;
      loginFailures.set(username, c);
      await audit.log({ headers: req.headers, ip: req.ip, clientIp: req.ip, user: null }, {
        action: 'LOGIN',
        targetType: 'USER',
        result: 0,
        detail: `账号或密码错误：${username}（连续失败 ${c} 次）`,
      });
      return fail(res, CODES.AUTH_FAILED, undefined, { needCaptcha: c >= config.auth.captchaAfterFailures });
    }
    if (user.status !== 1) {
      return fail(res, CODES.FORBIDDEN, '账号已被禁用，请联系系统管理员');
    }

    loginFailures.delete(username);
    await db.execute(`UPDATE t_user SET last_login_at = NOW() WHERE id = ?`, [user.id]);

    const profile = await account.buildProfile(user);
    const { token, payload } = tokenUtil.sign(
      { userId: user.id, username: user.username, realName: user.real_name, role: user.role },
      config.auth.idleTimeoutMinutes
    );
    sessions.create(payload);

    await audit.log(
      { headers: req.headers, ip: req.ip, clientIp: req.ip, user: { userId: user.id, username: user.username } },
      { action: 'LOGIN', targetType: 'USER', targetId: user.id, result: 1, detail: '登录成功' }
    );

    return ok(res, {
      token,
      expiresInMinutes: config.auth.idleTimeoutMinutes,
      profile,
    });
  })
);

/** 注销 */
router.post(
  '/logout',
  authenticate,
  wrap(async (req, res) => {
    sessions.destroy(req.user.jti);
    return ok(res, { logout: true });
  })
);

/** 当前用户信息与角色 */
router.get(
  '/me',
  authenticate,
  wrap(async (req, res) => {
    const user = await account.getUserById(req.user.userId);
    const profile = await account.buildProfile(user);
    const unread = await db.queryOne(
      `SELECT COUNT(*) AS cnt FROM t_notice WHERE user_id = ? AND is_read = 0`,
      [req.user.userId]
    );
    return ok(res, { profile, unreadNotice: Number(unread.cnt) });
  })
);

module.exports = router;
