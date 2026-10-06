'use strict';

/**
 * 候补接口（见设计文档表 4、4.6 候补递补规则）。
 */

const express = require('express');
const rules = require('../services/ruleService');
const waitlist = require('../services/waitlistService');
const { ROLE, requireRole, authenticate, wrap } = require('../middleware/auth');
const { loadStudent } = require('../middleware/student');
const { idempotent, rateLimited } = require('../middleware/guards');
const { ok } = require('../utils/response');
const { CODES, AppError } = require('../utils/errors');

const router = express.Router();

const studentOnly = [authenticate, requireRole(ROLE.STUDENT), loadStudent];

/** 加入候补 */
router.post(
  '/waitlist',
  ...studentOnly,
  rateLimited,
  idempotent(
    wrap(async (req, res) => {
      const offeringId = Number(req.body && req.body.offeringId);
      if (!offeringId) throw new AppError(CODES.BAD_REQUEST, '缺少 offeringId');
      const data = await waitlist.join(req, req.student, offeringId);
      return ok(res, data, `已加入候补，当前排位第 ${data.queueNo} 位`);
    })
  )
);

/** 取消候补 */
router.delete(
  '/waitlist/:offeringId',
  ...studentOnly,
  idempotent(
    wrap(async (req, res) => {
      const data = await waitlist.cancel(req, req.student, Number(req.params.offeringId));
      return ok(res, data, '已取消候补');
    })
  )
);

/** 确认递补名额 */
router.post(
  '/waitlist/:offeringId/confirm',
  ...studentOnly,
  wrap(async (req, res) => {
    const data = await waitlist.confirm(req, req.student, Number(req.params.offeringId));
    return ok(res, data, '已确认递补名额');
  })
);

/** 我的候补与当前排位 */
router.get(
  '/waitlist/mine',
  ...studentOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const termId = Number(req.query.termId) || term.id;
    const list = await waitlist.mine(req.student, termId);
    return ok(res, { list, waitlistConfirmHours: 24 });
  })
);

module.exports = router;
