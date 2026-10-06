'use strict';

/**
 * 选课、退课、换课与我的已选（见设计文档表 4、6.1、6.2、6.3）。
 */

const express = require('express');
const rules = require('../services/ruleService');
const courseService = require('../services/courseService');
const enrollment = require('../services/enrollmentService');
const { ROLE, requireRole, authenticate, wrap } = require('../middleware/auth');
const { loadStudent } = require('../middleware/student');
const { idempotent, rateLimited } = require('../middleware/guards');
const { ok } = require('../utils/response');
const { CODES, AppError } = require('../utils/errors');

const router = express.Router();

const studentOnly = [authenticate, requireRole(ROLE.STUDENT), loadStudent];

/** 选课 */
router.post(
  '/enrollments',
  ...studentOnly,
  rateLimited,
  idempotent(
    wrap(async (req, res) => {
      const offeringId = Number(req.body && req.body.offeringId);
      if (!offeringId) throw new AppError(CODES.BAD_REQUEST, '缺少 offeringId');
      const data = await enrollment.enroll(req, req.student, offeringId);
      return ok(res, data, '选课成功');
    })
  )
);

/** 退课 */
router.delete(
  '/enrollments/:offeringId',
  ...studentOnly,
  rateLimited,
  idempotent(
    wrap(async (req, res) => {
      const offeringId = Number(req.params.offeringId);
      const data = await enrollment.drop(req, req.student, offeringId);
      const msg = data.promoted && data.promoted.length
        ? '退课成功，名额已递补给候补同学'
        : '退课成功';
      return ok(res, data, msg);
    })
  )
);

/** 换课（先占后放） */
router.post(
  '/enrollments/switch',
  ...studentOnly,
  rateLimited,
  idempotent(
    wrap(async (req, res) => {
      const from = Number(req.body && req.body.fromOfferingId);
      const to = Number(req.body && req.body.toOfferingId);
      if (!from || !to) throw new AppError(CODES.BAD_REQUEST, '缺少 fromOfferingId 或 toOfferingId');
      const data = await enrollment.switchCourse(req, req.student, from, to);
      return ok(res, data, '换课成功');
    })
  )
);

/** 我的已选课程 */
router.get(
  '/enrollments/mine',
  ...studentOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const termId = Number(req.query.termId) || term.id;
    const list = await enrollment.myEnrollments(req.student, termId);
    const ctx = await courseService.buildStudentContext(req.student, termId);
    return ok(res, {
      list,
      totalCredit: ctx.creditInfo.total,
      byCategory: ctx.creditInfo.byCategory,
      creditRule: ctx.creditInfo.rule,
      categoryRules: ctx.categoryRules,
      batch: ctx.batchInfo.batch,
      nextBatch: ctx.batchInfo.next,
      dropDeadline: ctx.dropDeadline,
    });
  })
);

/** 我的课表（支持单双周切换） */
router.get(
  '/timetable',
  ...studentOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const termId = Number(req.query.termId) || term.id;
    const parity = req.query.parity === undefined ? null : Number(req.query.parity);
    const data = await enrollment.timetable(req.student, termId, parity);
    const ctx = await courseService.buildStudentContext(req.student, termId);
    return ok(res, {
      ...data,
      weekdays: [1, 2, 3, 4, 5, 6, 7].map((n) => courseService.weekdayText(n)),
      creditRule: ctx.creditInfo.rule,
    });
  })
);

module.exports = router;
