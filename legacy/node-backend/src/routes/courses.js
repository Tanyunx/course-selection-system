'use strict';

/**
 * 课程查询接口（见设计文档表 4、3.2.2 课程查询与浏览页）。
 */

const express = require('express');
const db = require('../db');
const rules = require('../services/ruleService');
const courseService = require('../services/courseService');
const account = require('../services/accountService');
const { ROLE, authenticate, wrap } = require('../middleware/auth');
const { ok, page } = require('../utils/response');
const { CODES, AppError } = require('../utils/errors');

const router = express.Router();

/** 当前学期 */
router.get(
  '/terms/current',
  authenticate,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const terms = await db.query(`SELECT * FROM t_term ORDER BY start_date DESC`);
    return ok(res, { current: term, terms });
  })
);

/** 筛选项元数据：类别、校区、年级（前端筛选区使用） */
router.get(
  '/meta/filters',
  authenticate,
  wrap(async (req, res) => {
    const categories = await db.query(`SELECT * FROM t_course_category ORDER BY id`);
    const campuses = await db.query(
      `SELECT DISTINCT campus FROM t_course_offering WHERE campus IS NOT NULL AND campus <> '' ORDER BY campus`
    );
    const weeks = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: courseService.weekdayText(n) }));
    return ok(res, {
      categories: categories.map((c) => ({ value: c.id, label: c.name, code: c.code })),
      campuses: campuses.map((c) => c.campus),
      weekdays: weeks,
      parities: [
        { value: 0, label: '全周' },
        { value: 1, label: '单周' },
        { value: 2, label: '双周' },
      ],
    });
  })
);

/** 课程查询：支持 termId、keyword、categoryId、weekday、available、campus、page、size */
router.get(
  '/courses',
  authenticate,
  wrap(async (req, res) => {
    const currentTerm = await rules.getCurrentTerm();
    const termId = Number(req.query.termId) || (currentTerm ? currentTerm.id : null);
    const pageNo = Number(req.query.page) || 1;
    const size = Math.min(Number(req.query.size) || 10, 50);

    const { rows, total } = await courseService.queryOfferings({
      termId,
      keyword: req.query.keyword,
      categoryId: req.query.categoryId,
      weekday: req.query.weekday,
      available: req.query.available,
      campus: req.query.campus,
      status: req.query.status,
      page: pageNo,
      size,
      sort: req.query.sort,
    });

    await courseService.attachSchedules(rows);

    // 学生视角下批量标注状态；其他角色仅返回基础信息
    if (req.user.role === ROLE.STUDENT) {
      const student = await account.getStudentByUserId(req.user.userId);
      if (student) {
        const ctx = await courseService.buildStudentContext(student, termId);
        await courseService.annotateOfferings(rows, ctx);
      }
    }

    return ok(
      res,
      page(
        rows.map((r) => ({
          offeringId: r.offering_id,
          courseId: r.course_id,
          courseCode: r.course_code,
          courseName: r.course_name,
          credit: Number(r.credit),
          categoryId: r.category_id,
          categoryName: r.category_name,
          dept: r.dept,
          description: r.description,
          teacherName: r.teacher_name,
          teacherTitle: r.teacher_title,
          capacity: r.capacity,
          enrolled: r.enrolled,
          remaining: r.remaining,
          heat: r.heat,
          offeringStatus: r.offering_status,
          campus: r.offering_campus,
          remark: r.remark,
          schedules: r.schedules,
          scheduleText: r.scheduleText,
          status: r.status,
          selectable: r.selectable,
          waitlistable: r.waitlistable,
          reasons: r.reasons,
          conflicts: r.conflicts,
          missingPrereq: r.missingPrereq,
          myEnrollment: r.myEnrollment,
          myWaitlist: r.myWaitlist,
          waitlistCount: r.waitlistCount,
          willTotalCredit: r.willTotalCredit,
        })),
        total,
        pageNo,
        size
      )
    );
  })
);

/** 开课详情：含排课、余量、热度、先修要求、可选状态 */
router.get(
  '/courses/:offeringId',
  authenticate,
  wrap(async (req, res) => {
    const offeringId = Number(req.params.offeringId);
    const currentTerm = await rules.getCurrentTerm();

    if (req.user.role === ROLE.STUDENT) {
      const student = await account.getStudentByUserId(req.user.userId);
      if (!student) throw new AppError(CODES.FORBIDDEN, '未找到学生档案');
      const ctx = await courseService.buildStudentContext(student, currentTerm.id);
      const detail = await courseService.getOfferingDetail(offeringId, ctx);
      if (!detail) throw new AppError(CODES.OFFERING_NOT_FOUND);
      return ok(res, {
        offering: {
          offeringId: detail.offering_id,
          courseCode: detail.course_code,
          courseName: detail.course_name,
          credit: Number(detail.credit),
          categoryName: detail.category_name,
          dept: detail.dept,
          description: detail.description,
          teacherName: detail.teacher_name,
          teacherTitle: detail.teacher_title,
          teacherCollege: detail.teacher_college,
          capacity: detail.capacity,
          enrolled: detail.enrolled,
          remaining: detail.remaining,
          heat: detail.heat,
          campus: detail.offering_campus,
          remark: detail.remark,
          schedules: detail.schedules,
          scheduleText: detail.scheduleText,
          prereqList: detail.prereqList,
          waitlistQueue: detail.waitlistQueue,
        },
        studentState: {
          status: detail.status,
          selectable: detail.selectable,
          waitlistable: detail.waitlistable,
          reasons: detail.reasons,
          conflicts: detail.conflicts,
          myEnrollment: detail.myEnrollment,
          myWaitlist: detail.myWaitlist,
          waitlistCount: detail.waitlistCount,
          willTotalCredit: detail.willTotalCredit,
        },
        context: {
          batch: ctx.batchInfo.batch,
          nextBatch: ctx.batchInfo.next,
          credit: ctx.creditInfo,
          categoryRules: ctx.categoryRules,
          dropDeadline: ctx.dropDeadline,
        },
      });
    }

    const rows = await db.query(
      `SELECT o.*, c.course_code, c.name AS course_name, c.credit, c.dept, c.description,
              cat.name AS category_name, tu.real_name AS teacher_name, t.title AS teacher_title
         FROM t_course_offering o
         JOIN t_course c ON c.id = o.course_id
         JOIN t_course_category cat ON cat.id = c.category_id
         JOIN t_teacher t ON t.id = o.teacher_id
         JOIN t_user tu ON tu.id = t.user_id
        WHERE o.id = ?`,
      [offeringId]
    );
    if (!rows.length) throw new AppError(CODES.OFFERING_NOT_FOUND);
    const o = rows[0];
    const schedules = await db.query(
      `SELECT * FROM t_course_schedule WHERE offering_id = ? ORDER BY weekday, start_period`,
      [offeringId]
    );
    return ok(res, {
      offering: {
        offeringId: o.id,
        courseCode: o.course_code,
        courseName: o.course_name,
        credit: Number(o.credit),
        categoryName: o.category_name,
        dept: o.dept,
        description: o.description,
        teacherName: o.teacher_name,
        teacherTitle: o.teacher_title,
        capacity: o.capacity,
        enrolled: o.enrolled,
        remaining: Math.max(0, o.capacity - o.enrolled),
        heat: rules.heatOf(o.enrolled, o.capacity),
        campus: o.campus,
        remark: o.remark,
        schedules,
        scheduleText: schedules.map(courseService.scheduleText),
        prereqList: [],
        waitlistQueue: [],
      },
    });
  })
);

module.exports = router;
