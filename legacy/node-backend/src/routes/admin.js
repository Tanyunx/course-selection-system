'use strict';

/**
 * 教务管理端接口（见设计文档 3.4、表 4 与表 26 角色权限矩阵）。
 * 权限：教务管理员（academic_admin）；系统管理员在本文件中被显式排除，
 * 用户与权限、审计日志、运行监控三组接口由 sys.js 提供。
 */

const express = require('express');
const db = require('../db');
const rules = require('../services/ruleService');
const courseService = require('../services/courseService');
const notice = require('../services/notice');
const audit = require('../services/audit');
const { ROLE, requireRole, authenticate, wrap } = require('../middleware/auth');
const { ok, page } = require('../utils/response');
const { CODES, AppError } = require('../utils/errors');
const period = require('../utils/period');

const router = express.Router();

const academicOnly = [authenticate, requireRole(ROLE.ACADEMIC_ADMIN)];

/* ------------------------------------------------------------------ */
/* 概览                                                                */
/* ------------------------------------------------------------------ */

router.get(
  '/admin/dashboard',
  ...academicOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const stat = await db.queryOne(
      `SELECT
         COUNT(*) AS offering_count,
         IFNULL(SUM(capacity),0) AS total_capacity,
         IFNULL(SUM(enrolled),0) AS total_enrolled
       FROM t_course_offering WHERE term_id = ? AND status <> 0`,
      [term.id]
    );
    const enrollCount = await db.queryOne(
      `SELECT COUNT(*) AS cnt FROM t_enrollment e
         JOIN t_course_offering o ON o.id = e.offering_id
        WHERE o.term_id = ? AND e.status = 1`,
      [term.id]
    );
    const waitCount = await db.queryOne(
      `SELECT COUNT(*) AS cnt FROM t_waitlist w
         JOIN t_course_offering o ON o.id = w.offering_id
        WHERE o.term_id = ? AND w.status = 1`,
      [term.id]
    );
    const studentCount = await db.queryOne(`SELECT COUNT(*) AS cnt FROM t_student`);
    const hot = await db.query(
      `SELECT o.id AS offering_id, c.name AS course_name, c.course_code,
              o.capacity, o.enrolled,
              ROUND(o.enrolled / o.capacity * 100, 1) AS rate
         FROM t_course_offering o JOIN t_course c ON c.id = o.course_id
        WHERE o.term_id = ? AND o.status <> 0
        ORDER BY rate DESC LIMIT 8`,
      [term.id]
    );
    const full = await db.queryOne(
      `SELECT COUNT(*) AS cnt FROM t_course_offering WHERE term_id = ? AND enrolled >= capacity`,
      [term.id]
    );
    const batches = await db.query(
      `SELECT * FROM t_enroll_batch WHERE term_id = ? ORDER BY priority`,
      [term.id]
    );
    return ok(res, {
      term,
      offeringCount: Number(stat.offering_count),
      totalCapacity: Number(stat.total_capacity),
      totalEnrolled: Number(stat.total_enrolled),
      utilization: stat.total_capacity ? Math.round((stat.total_enrolled / stat.total_capacity) * 1000) / 10 : 0,
      enrollCount: Number(enrollCount.cnt),
      waitCount: Number(waitCount.cnt),
      studentCount: Number(studentCount.cnt),
      fullCount: Number(full.cnt),
      hotCourses: hot,
      batches,
    });
  })
);

/* ------------------------------------------------------------------ */
/* 课程目录                                                            */
/* ------------------------------------------------------------------ */

router.get(
  '/admin/courses',
  ...academicOnly,
  wrap(async (req, res) => {
    const pageNo = Number(req.query.page) || 1;
    const size = Math.min(Number(req.query.size) || 20, 100);
    const where = ['1 = 1'];
    const params = [];
    if (req.query.keyword) {
      where.push('(c.name LIKE ? OR c.course_code LIKE ?)');
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`);
    }
    if (req.query.categoryId) {
      where.push('c.category_id = ?');
      params.push(Number(req.query.categoryId));
    }
    const whereSql = where.join(' AND ');
    const totalRow = await db.queryOne(
      `SELECT COUNT(*) AS total FROM t_course c WHERE ${whereSql}`,
      params
    );
    const rows = await db.query(
      `SELECT c.*, cat.name AS category_name,
              (SELECT COUNT(*) FROM t_course_offering o WHERE o.course_id = c.id) AS offering_count,
              (SELECT COUNT(*) FROM t_course_prereq p WHERE p.course_id = c.id) AS prereq_count
         FROM t_course c JOIN t_course_category cat ON cat.id = c.category_id
        WHERE ${whereSql}
        ORDER BY c.course_code LIMIT ? OFFSET ?`,
      [...params, size, (pageNo - 1) * size]
    );
    return ok(res, page(rows.map((r) => ({ ...r, credit: Number(r.credit) })), Number(totalRow.total), pageNo, size));
  })
);

router.post(
  '/admin/courses',
  ...academicOnly,
  wrap(async (req, res) => {
    const { courseCode, name, categoryId, credit, dept, description } = req.body || {};
    if (!courseCode || !name || !categoryId || credit === undefined) {
      throw new AppError(CODES.BAD_REQUEST, '课程代码、名称、类别与学分为必填项');
    }
    const exist = await db.queryOne(`SELECT id FROM t_course WHERE course_code = ?`, [courseCode]);
    if (exist) throw new AppError(CODES.BAD_REQUEST, `课程代码 ${courseCode} 已存在`);
    const r = await db.execute(
      `INSERT INTO t_course (course_code, name, category_id, credit, dept, description, status)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [courseCode, name, Number(categoryId), Number(credit), dept || null, description || null]
    );
    await audit.log(req, { action: 'COURSE_CREATE', targetType: 'COURSE', targetId: r.insertId, result: 1, detail: name });
    return ok(res, { id: r.insertId }, '课程已创建');
  })
);

router.put(
  '/admin/courses/:id',
  ...academicOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { name, categoryId, credit, dept, description, status } = req.body || {};
    const course = await db.queryOne(`SELECT * FROM t_course WHERE id = ?`, [id]);
    if (!course) throw new AppError(CODES.BAD_REQUEST, '课程不存在');

    await db.execute(
      `UPDATE t_course SET name = ?, category_id = ?, credit = ?, dept = ?, description = ?, status = ? WHERE id = ?`,
      [
        name || course.name,
        Number(categoryId || course.category_id),
        credit === undefined ? course.credit : Number(credit),
        dept === undefined ? course.dept : dept,
        description === undefined ? course.description : description,
        status === undefined ? course.status : Number(status),
        id,
      ]
    );
    await audit.log(req, { action: 'COURSE_UPDATE', targetType: 'COURSE', targetId: id, result: 1, detail: name || course.name });
    return ok(res, { id }, '课程已更新');
  })
);

router.delete(
  '/admin/courses/:id',
  ...academicOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const used = await db.queryOne(`SELECT COUNT(*) AS cnt FROM t_course_offering WHERE course_id = ?`, [id]);
    if (Number(used.cnt) > 0) throw new AppError(CODES.BAD_REQUEST, '该课程已有开课记录，不能删除，可改为停用');
    await db.execute(`DELETE FROM t_course_prereq WHERE course_id = ? OR prereq_course_id = ?`, [id, id]);
    await db.execute(`DELETE FROM t_course WHERE id = ?`, [id]);
    await audit.log(req, { action: 'COURSE_DELETE', targetType: 'COURSE', targetId: id, result: 1 });
    return ok(res, { id }, '课程已删除');
  })
);

/** 先修关系维护 */
router.get(
  '/admin/courses/:id/prereq',
  ...academicOnly,
  wrap(async (req, res) => {
    const rows = await db.query(
      `SELECT p.*, c.name AS prereq_name, c.course_code
         FROM t_course_prereq p JOIN t_course c ON c.id = p.prereq_course_id
        WHERE p.course_id = ? ORDER BY p.require_type, p.group_no`,
      [Number(req.params.id)]
    );
    return ok(res, { list: rows });
  })
);

router.post(
  '/admin/courses/:id/prereq',
  ...academicOnly,
  wrap(async (req, res) => {
    const courseId = Number(req.params.id);
    const list = Array.isArray(req.body && req.body.prereq) ? req.body.prereq : [];
    await db.withTransaction(async (conn) => {
      await conn.query(`DELETE FROM t_course_prereq WHERE course_id = ?`, [courseId]);
      for (const p of list) {
        await conn.query(
          `INSERT INTO t_course_prereq (course_id, prereq_course_id, require_type, group_no)
           VALUES (?, ?, ?, ?)`,
          [courseId, Number(p.prereqCourseId), Number(p.requireType || 1), Number(p.groupNo || 1)]
        );
      }
    });
    await audit.log(req, { action: 'PREREQ_UPDATE', targetType: 'COURSE', targetId: courseId, result: 1, detail: `先修关系 ${list.length} 条` });
    return ok(res, { courseId, count: list.length }, '先修关系已保存');
  })
);

/* ------------------------------------------------------------------ */
/* 开课计划与名额                                                       */
/* ------------------------------------------------------------------ */

router.get(
  '/admin/offerings',
  ...academicOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const termId = Number(req.query.termId) || term.id;
    const rows = await db.query(
      `SELECT o.id AS offering_id, o.capacity, o.enrolled, o.status, o.campus, o.remark,
              c.course_code, c.name AS course_name, c.credit, c.id AS course_id,
              cat.name AS category_name, t.id AS teacher_id, tu.real_name AS teacher_name
         FROM t_course_offering o
         JOIN t_course c ON c.id = o.course_id
         JOIN t_course_category cat ON cat.id = c.category_id
         JOIN t_teacher t ON t.id = o.teacher_id
         JOIN t_user tu ON tu.id = t.user_id
        WHERE o.term_id = ? ORDER BY c.course_code`,
      [termId]
    );
    await courseService.attachSchedules(rows);

    const ids = rows.map((r) => r.offering_id);
    const waitCounts = ids.length
      ? await db.query(
          `SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist WHERE status = 1 AND offering_id IN (?)
            GROUP BY offering_id`,
          [ids]
        )
      : [];
    const waitMap = new Map(waitCounts.map((c) => [c.offering_id, Number(c.cnt)]));
    const enrollCounts = ids.length
      ? await db.query(
          `SELECT offering_id, COUNT(*) AS cnt FROM t_enrollment WHERE status = 1 AND offering_id IN (?)
            GROUP BY offering_id`,
          [ids]
        )
      : [];
    const enrollMap = new Map(enrollCounts.map((c) => [c.offering_id, Number(c.cnt)]));
    const teachers = await db.query(
      `SELECT t.id, t.teacher_no, u.real_name, t.college, t.title
         FROM t_teacher t JOIN t_user u ON u.id = t.user_id ORDER BY t.teacher_no`
    );
    const courses = await db.query(
      `SELECT c.id, c.course_code, c.name, c.credit, c.category_id FROM t_course c WHERE c.status = 1 ORDER BY c.course_code`
    );

    return ok(res, {
      term,
      list: rows.map((r) => ({
        ...r,
        credit: Number(r.credit),
        remaining: Math.max(0, r.capacity - r.enrolled),
        heat: rules.heatOf(r.enrolled, r.capacity),
        waitlistCount: waitMap.get(r.offering_id) || 0,
        enrolledCount: enrollMap.get(r.offering_id) || 0,
      })),
      teachers,
      courses,
    });
  })
);

router.post(
  '/admin/offerings',
  ...academicOnly,
  wrap(async (req, res) => {
    const { courseId, termId, teacherId, capacity, campus, remark, schedules } = req.body || {};
    if (!courseId || !teacherId || !capacity) throw new AppError(CODES.BAD_REQUEST, '课程、教师与容量为必填项');
    const term = await rules.getCurrentTerm();
    const tid = Number(termId) || term.id;

    const dup = await db.queryOne(
      `SELECT id FROM t_course_offering WHERE course_id = ? AND term_id = ? AND teacher_id = ?`,
      [courseId, tid, teacherId]
    );
    if (dup) throw new AppError(CODES.BAD_REQUEST, '该课程在本学期已由该教师开课，不能重复开课');
    period.assertValidSchedules(schedules);

    const offeringId = await db.withTransaction(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO t_course_offering (course_id, term_id, teacher_id, capacity, enrolled, status, campus, remark)
         VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
        [Number(courseId), tid, Number(teacherId), Number(capacity), campus || null, remark || null]
      );
      const list = Array.isArray(schedules) ? schedules : [];
      for (const s of list) {
        await conn.query(
          `INSERT INTO t_course_schedule (offering_id, weekday, start_period, end_period, parity, campus, building, room)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            r.insertId,
            Number(s.weekday),
            Number(s.startPeriod),
            Number(s.endPeriod),
            Number(s.parity || 0),
            s.campus || campus || null,
            s.building || null,
            s.room || null,
          ]
        );
      }
      return r.insertId;
    });

    await audit.log(req, { action: 'OFFERING_CREATE', targetType: 'OFFERING', targetId: offeringId, result: 1, detail: `容量 ${capacity}` });
    return ok(res, { offeringId }, '开课已创建');
  })
);

/** 更新开课：容量调整、停开/开放、排课维护 */
router.put(
  '/admin/offerings/:id',
  ...academicOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const offering = await db.queryOne(`SELECT * FROM t_course_offering WHERE id = ?`, [id]);
    if (!offering) throw new AppError(CODES.OFFERING_NOT_FOUND);

    const { capacity, status, campus, remark, schedules } = req.body || {};
    if (capacity !== undefined && Number(capacity) < offering.enrolled) {
      throw new AppError(CODES.BAD_REQUEST, `容量不能小于已选人数 ${offering.enrolled}`);
    }
    period.assertValidSchedules(schedules);

    await db.withTransaction(async (conn) => {
      const newCapacity = capacity === undefined ? offering.capacity : Number(capacity);
      const newStatus = status === undefined ? offering.status : Number(status);
      await conn.query(`UPDATE t_course_offering SET capacity = ?, status = ?, campus = ?, remark = ? WHERE id = ?`, [
        newCapacity,
        newStatus,
        campus === undefined ? offering.campus : campus,
        remark === undefined ? offering.remark : remark,
        id,
      ]);
      // 容量或状态变化后重新推导"已满"状态
      await conn.query(
        `UPDATE t_course_offering SET status = 2 WHERE id = ? AND status = 1 AND enrolled >= capacity`,
        [id]
      );
      await conn.query(
        `UPDATE t_course_offering SET status = 1 WHERE id = ? AND status = 2 AND enrolled < capacity`,
        [id]
      );

      if (Array.isArray(schedules)) {
        await conn.query(`DELETE FROM t_course_schedule WHERE offering_id = ?`, [id]);
        for (const s of schedules) {
          await conn.query(
            `INSERT INTO t_course_schedule (offering_id, weekday, start_period, end_period, parity, campus, building, room)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
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
      }
    });

    const isCapacityChange = capacity !== undefined && Number(capacity) !== offering.capacity;
    await audit.log(req, {
      action: isCapacityChange ? 'CAPACITY_ADJUST' : 'OFFERING_UPDATE',
      targetType: 'OFFERING',
      targetId: id,
      result: 1,
      detail: isCapacityChange
        ? `容量 ${offering.capacity} → ${capacity}（已选 ${offering.enrolled}）`
        : '更新开课信息',
    });

    // 容量扩大后可能释放出名额，触发候补递补
    let promoteResult = null;
    if (capacity !== undefined && Number(capacity) > offering.enrolled) {
      const waitlist = require('../services/waitlistService');
      const r = await waitlist.promoteFromOffering(id);
      promoteResult = r.result;
    }
    return ok(res, { id, promoted: promoteResult }, '开课已更新');
  })
);

/** 名额管理列表（含候补人数与递补入口） */
router.get(
  '/admin/statistics',
  ...academicOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const rows = await db.query(
      `SELECT o.id AS offering_id, c.course_code, c.name AS course_name,
              tu.real_name AS teacher_name,
              o.capacity, o.enrolled, o.status,
              ROUND(o.enrolled / o.capacity * 100, 1) AS rate,
              IFNULL(w.cnt, 0) AS waitlist_count
         FROM t_course_offering o
         JOIN t_course c ON c.id = o.course_id
         JOIN t_teacher t ON t.id = o.teacher_id
         JOIN t_user tu ON tu.id = t.user_id
         LEFT JOIN (SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist WHERE status = 1 GROUP BY offering_id) w
                ON w.offering_id = o.id
        WHERE o.term_id = ?
        ORDER BY rate DESC, o.enrolled DESC`,
      [term.id]
    );
    return ok(res, { term, list: rows });
  })
);

/* ------------------------------------------------------------------ */
/* 批次与学分规则                                                       */
/* ------------------------------------------------------------------ */

router.get(
  '/admin/batches',
  ...academicOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const rows = await db.query(`SELECT * FROM t_enroll_batch WHERE term_id = ? ORDER BY priority`, [term.id]);
    const now = new Date();
    return ok(res, {
      term,
      list: rows.map((b) => ({
        ...b,
        typeText: b.type === 2 ? '补退选' : '正常选课',
        state: now < new Date(b.start_time) ? '未开始' : now > new Date(b.end_time) ? '已结束' : '进行中',
      })),
    });
  })
);

router.post(
  '/admin/batches',
  ...academicOnly,
  wrap(async (req, res) => {
    const { name, type, startTime, endTime, targetGrade, targetCollege, priority } = req.body || {};
    if (!name || !startTime || !endTime) throw new AppError(CODES.BAD_REQUEST, '批次名称与起止时间为必填项');
    const term = await rules.getCurrentTerm();
    const r = await db.execute(
      `INSERT INTO t_enroll_batch (term_id, name, type, start_time, end_time, target_grade, target_college, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        term.id,
        name,
        Number(type || 1),
        startTime.replace('T', ' '),
        endTime.replace('T', ' '),
        targetGrade || null,
        targetCollege || null,
        Number(priority || 0),
      ]
    );
    await audit.log(req, { action: 'BATCH_CREATE', targetType: 'BATCH', targetId: r.insertId, result: 1, detail: name });
    return ok(res, { id: r.insertId }, '批次已创建');
  })
);

router.put(
  '/admin/batches/:id',
  ...academicOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const b = await db.queryOne(`SELECT * FROM t_enroll_batch WHERE id = ?`, [id]);
    if (!b) throw new AppError(CODES.BAD_REQUEST, '批次不存在');
    const { name, type, startTime, endTime, targetGrade, targetCollege, priority, status } = req.body || {};
    await db.execute(
      `UPDATE t_enroll_batch SET name=?, type=?, start_time=?, end_time=?, target_grade=?, target_college=?, priority=?, status=? WHERE id=?`,
      [
        name || b.name,
        type === undefined ? b.type : Number(type),
        (startTime || b.start_time).toString().replace('T', ' '),
        (endTime || b.end_time).toString().replace('T', ' '),
        targetGrade === undefined ? b.target_grade : targetGrade,
        targetCollege === undefined ? b.target_college : targetCollege,
        priority === undefined ? b.priority : Number(priority),
        status === undefined ? b.status : Number(status),
        id,
      ]
    );
    await audit.log(req, { action: 'BATCH_UPDATE', targetType: 'BATCH', targetId: id, result: 1, detail: name || b.name });
    return ok(res, { id }, '批次已更新');
  })
);

router.delete(
  '/admin/batches/:id',
  ...academicOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await db.execute(`DELETE FROM t_enroll_batch WHERE id = ?`, [id]);
    await audit.log(req, { action: 'BATCH_DELETE', targetType: 'BATCH', targetId: id, result: 1 });
    return ok(res, { id }, '批次已删除');
  })
);

router.get(
  '/admin/credit-rules',
  ...academicOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const gradeRules = await db.query(`SELECT * FROM t_credit_rule WHERE term_id = ? ORDER BY grade`, [term.id]);
    const categoryRules = await rules.getCategoryCreditRules(term.id);
    const categories = await db.query(`SELECT * FROM t_course_category ORDER BY id`);
    return ok(res, {
      term,
      gradeRules: gradeRules.map((g) => ({ ...g, min_credit: Number(g.min_credit), max_credit: Number(g.max_credit) })),
      categoryRules: categoryRules.map((c) => ({
        ...c,
        min_credit: c.min_credit === null ? null : Number(c.min_credit),
        max_credit: c.max_credit === null ? null : Number(c.max_credit),
      })),
      categories,
    });
  })
);

router.post(
  '/admin/credit-rules',
  ...academicOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const { grade, minCredit, maxCredit } = req.body || {};
    if (!grade || maxCredit === undefined) throw new AppError(CODES.BAD_REQUEST, '年级与学分上限为必填项');
    await db.execute(
      `INSERT INTO t_credit_rule (term_id, grade, min_credit, max_credit) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE min_credit = VALUES(min_credit), max_credit = VALUES(max_credit)`,
      [term.id, grade, Number(minCredit || 0), Number(maxCredit)]
    );
    await audit.log(req, { action: 'CREDIT_RULE_UPDATE', targetType: 'TERM', targetId: term.id, result: 1, detail: `${grade} 级上限 ${maxCredit}` });
    return ok(res, { grade }, '学分规则已保存');
  })
);

router.post(
  '/admin/category-credit-rules',
  ...academicOnly,
  wrap(async (req, res) => {
    const term = await rules.getCurrentTerm();
    const { categoryId, minCredit, maxCredit } = req.body || {};
    if (!categoryId) throw new AppError(CODES.BAD_REQUEST, '课程类别为必填项');
    await db.execute(
      `INSERT INTO t_category_credit_rule (term_id, category_id, min_credit, max_credit) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE min_credit = VALUES(min_credit), max_credit = VALUES(max_credit)`,
      [
        term.id,
        Number(categoryId),
        minCredit === undefined || minCredit === '' || minCredit === null ? null : Number(minCredit),
        maxCredit === undefined || maxCredit === '' || maxCredit === null ? null : Number(maxCredit),
      ]
    );
    await audit.log(req, { action: 'CATEGORY_CREDIT_RULE_UPDATE', targetType: 'TERM', targetId: term.id, result: 1 });
    return ok(res, { categoryId }, '类别学分要求已保存');
  })
);

/* ------------------------------------------------------------------ */
/* 公告                                                                */
/* ------------------------------------------------------------------ */

router.get(
  '/admin/announcements',
  ...academicOnly,
  wrap(async (req, res) => {
    const rows = await db.query(
      `SELECT a.*, u.real_name AS publisher_name FROM t_announcement a
         JOIN t_user u ON u.id = a.publisher_id ORDER BY a.publish_time DESC LIMIT 50`
    );
    return ok(res, { list: rows });
  })
);

router.post(
  '/admin/announcements',
  ...academicOnly,
  wrap(async (req, res) => {
    const { title, content, targetScope, targetGrade, publish } = req.body || {};
    if (!title || !content) throw new AppError(CODES.BAD_REQUEST, '公告标题与正文为必填项');
    const status = publish === false ? 0 : 1;

    const id = await db.withTransaction(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO t_announcement (publisher_id, title, content, target_scope, publish_time, status)
         VALUES (?, ?, ?, ?, NOW(), ?)`,
        [req.user.userId, title, content, targetScope || null, status]
      );
      if (status === 1) {
        // 向目标范围投递站内通知
        const sql = targetGrade
          ? `SELECT u.id FROM t_user u JOIN t_student s ON s.user_id = u.id WHERE u.role = 1 AND s.grade = ?`
          : `SELECT id FROM t_user WHERE role = 1`;
        const [users] = await conn.query(sql, targetGrade ? [targetGrade] : []);
        for (const u of users) {
          await notice.send(
            u.id,
            notice.TYPE.ANNOUNCEMENT,
            `新公告：${title}`,
            String(content).slice(0, 200),
            r.insertId,
            conn
          );
        }
      }
      return r.insertId;
    });

    await audit.log(req, { action: 'ANNOUNCEMENT_PUBLISH', targetType: 'ANNOUNCEMENT', targetId: id, result: 1, detail: title });
    return ok(res, { id }, status === 1 ? '公告已发布并投递通知' : '公告已保存为草稿');
  })
);

router.put(
  '/admin/announcements/:id/status',
  ...academicOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const status = Number((req.body || {}).status);
    await db.execute(`UPDATE t_announcement SET status = ? WHERE id = ?`, [status, id]);
    await audit.log(req, { action: 'ANNOUNCEMENT_STATUS', targetType: 'ANNOUNCEMENT', targetId: id, result: 1, detail: `状态 ${status}` });
    return ok(res, { id, status }, '公告状态已更新');
  })
);

module.exports = router;
