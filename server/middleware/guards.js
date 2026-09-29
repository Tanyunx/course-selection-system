'use strict';

/**
 * 写操作守卫：幂等去重（2.4）与防脚本限速（4.5）。
 */

const idem = require('../store/idempotency');
const rateLimit = require('../store/rateLimit');
const { CODES } = require('../utils/errors');
const { fail } = require('../utils/response');

/** 幂等：同一 requestId 重复提交直接返回首次结果，仅缓存成功与业务错误响应 */
function idempotent(handler) {
  return async (req, res) => {
    const requestId = (req.body && req.body.requestId) || req.query.requestId || null;
    req.requestId = requestId;

    if (requestId) {
      const cached = idem.hit(req.user.userId, requestId);
      if (cached) {
        res.setHeader('X-Idempotent-Replay', 'true');
        return res.json(cached);
      }
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (requestId && body && typeof body.code === 'number') {
        idem.save(req.user.userId, requestId, body);
      }
      return originalJson(body);
    };
    return handler(req, res);
  };
}

/** 防脚本刷课限速：窗口内超过软阈值返回 9001，超过硬阈值要求验证码 */
function rateLimited(req, res, next) {
  const state = rateLimit.check(req.user.userId);
  if (state.needCaptcha) {
    return fail(res, CODES.RATE_LIMITED, '操作过于频繁，请完成安全验证后重试', {
      needCaptcha: true,
      count: state.count,
    });
  }
  if (state.limited) {
    return fail(res, CODES.RATE_LIMITED, `操作过于频繁，请 ${state.retryAfter} 秒后再试`, {
      retryAfter: state.retryAfter,
      count: state.count,
    });
  }
  return next();
}

module.exports = { idempotent, rateLimited };
