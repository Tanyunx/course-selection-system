'use strict';

/**
 * 鉴权与 RBAC 中间件（见设计文档 2.4、7.3 与表 26 角色权限矩阵）。
 */

const tokenUtil = require('../utils/token');
const sessions = require('../store/sessionStore');
const { CODES, AppError } = require('../utils/errors');
const { fail } = require('../utils/response');

const ROLE = {
  STUDENT: 1,
  TEACHER: 2,
  ACADEMIC_ADMIN: 3,
  SYS_ADMIN: 4,
};

const ROLE_NAME = {
  [ROLE.STUDENT]: 'student',
  [ROLE.TEACHER]: 'teacher',
  [ROLE.ACADEMIC_ADMIN]: 'academic_admin',
  [ROLE.SYS_ADMIN]: 'sys_admin',
};

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.headers['x-token']) return String(req.headers['x-token']).trim();
  return null;
}

/** 解析令牌并加载会话；未登录返回 1002 */
function authenticate(req, res, next) {
  const raw = readToken(req);
  const payload = raw ? tokenUtil.verify(raw) : null;
  if (!payload) return fail(res, CODES.UNAUTHORIZED);
  if (!sessions.get(payload.jti)) return fail(res, CODES.UNAUTHORIZED);
  if (sessions.isIdle(payload.jti)) {
    sessions.destroy(payload.jti);
    return fail(res, CODES.UNAUTHORIZED);
  }
  const s = sessions.touch(payload.jti);
  req.user = {
    userId: s.userId,
    username: s.username,
    realName: s.realName,
    role: s.role,
    jti: payload.jti,
  };
  req.clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  return next();
}

/** 角色校验；不匹配统一返回 1003，并把越权访问写入审计日志 */
function requireRole(...roles) {
  return async (req, res, next) => {
    if (!req.user) return fail(res, CODES.UNAUTHORIZED);
    if (!roles.includes(req.user.role)) {
      try {
        const audit = require('../services/audit');
        await audit.log(req, {
          action: 'FORBIDDEN_ACCESS',
          targetType: 'API',
          result: 0,
          detail: `角色 ${ROLE_NAME[req.user.role]} 访问受限接口 ${req.method} ${req.baseUrl}${req.path}`,
        });
      } catch (_) {
        /* 审计失败不影响主流程 */
      }
      return fail(res, CODES.FORBIDDEN);
    }
    return next();
  };
}

/** 包装异步路由，统一捕获异常并转为 9002 */
function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (err instanceof AppError) {
        return fail(res, err.code, err.message, err.extra);
      }
      // eslint-disable-next-line no-console
      console.error('[UNHANDLED]', req.method, req.originalUrl, err);
      return fail(res, CODES.INTERNAL_ERROR, undefined, {
        detail: process.env.NODE_ENV === 'production' ? undefined : String(err.message || err),
      });
    }
  };
}

module.exports = { ROLE, ROLE_NAME, authenticate, requireRole, wrap };
