'use strict';

/**
 * 教师端接口（见设计文档 3.3、表 4）。
 * 教师可维护本人开课的上课时间与地点；容量由教务设定，教师不可修改。
 */

const express = require('express');
const db = require('../db');
const rules = require('../services/ruleService');
const courseService = require('../services/courseService');
const audit = require('../services/audit');
const { ROLE, requireRole, authenticate, wrap } = require('../middleware/auth');
const { loadTeacher } = require('../middleware/student');
const period = require('../utils/period');
const { ok } = require('../utils/response');
const { CODES, AppError } = require('../utils/errors');

const router = express.Router();

const teacherOnly = [authenticate, requireRole(ROLE.TEACHER, ROLE.ACADEMIC_ADMIN)];

/** 我的开课列表 */
router.get(
  '/teacher/offerings',
  ...teacherOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();

    let teacherRows;
    if (req.user.role === ROLE.TEACHER) {
      const teacher = await require('../services/accountService').getTeacherByUserId(req.user.userId);
      if (!teacher) throw new AppError(CODES.FORBIDDEN, '未找到教师档案');
      teacherRows = [teacher.id];
    } else {
      const all = await db.query(`SELECT id FROM t_teacher`);
      teacherRows = all.map((t) => t.id);
    }

    const rows = await db.query(
      `SELECT o.id AS offering_id, o.capacity, o.enrolled, o.status, o.campus, o.remark,
              c.course_code, c.name AS course_name, c.credit, cat.name AS category_name,
              tu.real_name AS teacher_name
         FROM t_course_offering o
         JOIN t_course c ON c.id = o.course_id
         JOIN t_course_category cat ON cat.id = c.category_id
         JOIN t_teacher t ON t.id = o.teacher_id
         JOIN t_user tu ON tu.id = t.user_id
        WHERE o.term_id = ? AND o.teacher_id IN (?)
        ORDER BY c.course_code`,
      [term.id, teacherRows]
    );
    await courseService.attachSchedules(rows);

    const counts = await db.query(
      `SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist WHERE status = 1 AND offering_id IN (?)
        GROUP BY offering_id`,
      [rows.length ? rows.map((r) => r.offering_id) : [0]]
    );
    const countMap = new Map(counts.map((c) => [c.offering_id, Number(c.cnt)]));

    return ok(res, {
      term,
      list: rows.map((r) => ({
        offeringId: r.offering_id,
        courseCode: r.course_code,
        courseName: r.course_name,
        credit: Number(r.credit),
        categoryName: r.category_name,
        teacherName: r.teacher_name,
        capacity: r.capacity,
        enrolled: r.enrolled,
        remaining: Math.max(0, r.capacity - r.enrolled),
        heat: rules.heatOf(r.enrolled, r.capacity),
        status: r.status,
        campus: r.campus,
        remark: r.remark,
        schedules: r.schedules,
        scheduleText: r.scheduleText,
        waitlistCount: countMap.get(r.offering_id) || 0,
      })),
    });
  })
);

/** 维护上课时间与地点（整体替换该开课的排课时段） */
router.put(
  '/teacher/offerings/:id',
  ...teacherOnly,
  wrap(async (req, res) => {
    const offeringId = Number(req.params.id);
    const offering = await db.queryOne(`SELECT * FROM t_course_offering WHERE id = ?`, [offeringId]);
    if (!offering) throw new AppError(CODES.OFFERING_NOT_FOUND);

    if (req.user.role === ROLE.TEACHER) {
      const teacher = await require('../services/accountService').getTeacherByUserId(req.user.userId);
      if (!teacher || teacher.id !== offering.teacher_id) {
        throw new AppError(CODES.FORBIDDEN, '只能维护本人的开课');
      }
    }

    const schedules = Array.isArray(req.body && req.body.schedules) ? req.body.schedules : [];
    period.assertValidSchedules(schedules);

    await db.withTransaction(async (conn) => {
      await conn.query(`DELETE FROM t_course_schedule WHERE offering_id = ?`, [offeringId]);
      for (const s of schedules) {
        await conn.query(
          `INSERT INTO t_course_schedule (offering_id, weekday, start_period, end_period, parity, campus, building, room)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            offeringId,
            Number(s.weekday),
            Number(s.startPeriod),
            Number(s.endPeriod),
            Number(s.parity || 0),
            s.campus || null,
            s.building || null,
            s.room || null,
          ]
        );
      }
      if (req.body && req.body.remark !== undefined) {
        await conn.query(`UPDATE t_course_offering SET remark = ? WHERE id = ?`, [
          String(req.body.remark).slice(0, 200),
          offeringId,
        ]);
      }
    });

    await audit.log(req, {
      action: 'TEACHER_UPDATE_SCHEDULE',
      targetType: 'OFFERING',
      targetId: offeringId,
      result: 1,
      detail: `维护排课：共 ${schedules.length} 个时段`,
    });

    return ok(res, { offeringId, scheduleCount: schedules.length }, '上课时间与地点已保存');
  })
);

/** 选课学生名单 */
router.get(
  '/teacher/offerings/:id/students',
  ...teacherOnly,
  wrap(async (req, res) => {
    const offeringId = Number(req.params.id);
    const offering = await db.queryOne(`SELECT * FROM t_course_offering WHERE id = ?`, [offeringId]);
    if (!offering) throw new AppError(CODES.OFFERING_NOT_FOUND);
    if (req.user.role === ROLE.TEACHER) {
      const teacher = await require('../services/accountService').getTeacherByUserId(req.user.userId);
      if (!teacher || teacher.id !== offering.teacher_id) throw new AppError(CODES.FORBIDDEN, '只能查看本人开课名单');
    }

    const students = await db.query(
      `SELECT s.student_no, u.real_name, s.grade, s.college, s.major,
              e.select_time, e.source,
              CASE e.source WHEN 2 THEN '候补递补' ELSE '正常选课' END AS source_text
         FROM t_enrollment e
         JOIN t_student s ON s.id = e.student_id
         JOIN t_user u ON u.id = s.user_id
        WHERE e.offering_id = ? AND e.status = 1
        ORDER BY e.select_time`,
      [offeringId]
    );

    const waitlist = await db.query(
      `SELECT w.queue_no, s.student_no, u.real_name, w.join_time, w.status
         FROM t_waitlist w
         JOIN t_student s ON s.id = w.student_id
         JOIN t_user u ON u.id = s.user_id
        WHERE w.offering_id = ? AND w.status IN (1, 2)
        ORDER BY w.queue_no`,
      [offeringId]
    );

    return ok(res, { students, waitlist, capacity: offering.capacity, enrolled: offering.enrolled });
  })
);

module.exports = router;
