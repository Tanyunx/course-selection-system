'use strict';

/**
 * 系统管理端接口（见设计文档 3.5、表 4 与表 26）。
 * 权限：系统管理员（sys_admin），涵盖用户与权限管理、审计日志、运行监控。
 * 注意：本路由需在 admin.js 之前挂载，以便 /admin/users 等路径优先命中。
 */

const express = require('express');
const db = require('../db');
const pwd = require('../utils/password');
const sessions = require('../store/sessionStore');
const metrics = require('../store/metrics');
const audit = require('../services/audit');
const { ROLE, requireRole, authenticate, wrap } = require('../middleware/auth');
const { ok, page } = require('../utils/response');
const { CODES, AppError } = require('../utils/errors');

const router = express.Router();

const sysOnly = [authenticate, requireRole(ROLE.SYS_ADMIN)];

const ROLE_TEXT = { 1: '学生', 2: '教师', 3: '教务管理员', 4: '系统管理员' };

/* ------------------------------------------------------------------ */
/* 用户与权限                                                          */
/* ------------------------------------------------------------------ */

router.get(
  '/admin/users',
  ...sysOnly,
  wrap(async (req, res) => {
    const pageNo = Number(req.query.page) || 1;
    const size = Math.min(Number(req.query.size) || 20, 100);
    const where = ['1 = 1'];
    const params = [];
    if (req.query.keyword) {
      where.push('(u.username LIKE ? OR u.real_name LIKE ?)');
      params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`);
    }
    if (req.query.role) {
      where.push('u.role = ?');
      params.push(Number(req.query.role));
    }
    if (req.query.status !== undefined && req.query.status !== '') {
      where.push('u.status = ?');
      params.push(Number(req.query.status));
    }
    const whereSql = where.join(' AND ');
    const totalRow = await db.queryOne(`SELECT COUNT(*) AS total FROM t_user u WHERE ${whereSql}`, params);
    const rows = await db.query(
      `SELECT u.id, u.username, u.real_name, u.role, u.status, u.last_login_at, u.created_at,
              s.student_no, s.grade, s.college, s.major,
              t.teacher_no, t.college AS teacher_college, t.title
         FROM t_user u
         LEFT JOIN t_student s ON s.user_id = u.id
         LEFT JOIN t_teacher t ON t.user_id = u.id
        WHERE ${whereSql}
        ORDER BY u.role, u.username LIMIT ? OFFSET ?`,
      [...params, size, (pageNo - 1) * size]
    );
    return ok(
      res,
      page(
        rows.map((r) => ({ ...r, roleText: ROLE_TEXT[r.role] || '未知' })),
        Number(totalRow.total),
        pageNo,
        size
      )
    );
  })
);

router.post(
  '/admin/users',
  ...sysOnly,
  wrap(async (req, res) => {
    const { username, password, realName, role, studentNo, grade, college, major, teacherNo, title } = req.body || {};
    if (!username || !password || !realName || !role) {
      throw new AppError(CODES.BAD_REQUEST, '账号、密码、姓名与角色为必填项');
    }
    const exists = await db.queryOne(`SELECT id FROM t_user WHERE username = ?`, [username]);
    if (exists) throw new AppError(CODES.BAD_REQUEST, `账号 ${username} 已存在`);

    const userId = await db.withTransaction(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO t_user (username, password_hash, real_name, role, status) VALUES (?, ?, ?, ?, 1)`,
        [username, pwd.hash(password), realName, Number(role)]
      );
      if (Number(role) === ROLE.STUDENT) {
        await conn.query(
          `INSERT INTO t_student (user_id, student_no, grade, college, major) VALUES (?, ?, ?, ?, ?)`,
          [r.insertId, studentNo || username, grade || '', college || '', major || null]
        );
      } else if (Number(role) === ROLE.TEACHER) {
        await conn.query(
          `INSERT INTO t_teacher (user_id, teacher_no, college, title) VALUES (?, ?, ?, ?)`,
          [r.insertId, teacherNo || username, college || '', title || null]
        );
      }
      return r.insertId;
    });

    await audit.log(req, { action: 'USER_CREATE', targetType: 'USER', targetId: userId, result: 1, detail: `${username} / ${ROLE_TEXT[Number(role)]}` });
    return ok(res, { userId }, '用户已创建');
  })
);

router.put(
  '/admin/users/:id',
  ...sysOnly,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const user = await db.queryOne(`SELECT * FROM t_user WHERE id = ?`, [id]);
    if (!user) throw new AppError(CODES.BAD_REQUEST, '用户不存在');

    const { role, status, realName, newPassword } = req.body || {};
    if (id === req.user.userId && status !== undefined && Number(status) === 0) {
      throw new AppError(CODES.BAD_REQUEST, '不能禁用当前登录的管理员账号');
    }

    await db.execute(
      `UPDATE t_user SET role = ?, status = ?, real_name = ?, password_hash = ? WHERE id = ?`,
      [
        role === undefined ? user.role : Number(role),
        status === undefined ? user.status : Number(status),
        realName || user.real_name,
        newPassword ? pwd.hash(newPassword) : user.password_hash,
        id,
      ]
    );

    await audit.log(req, {
      action: 'USER_UPDATE',
      targetType: 'USER',
      targetId: id,
      result: 1,
      detail: `角色 ${user.role} → ${role === undefined ? user.role : role}；状态 ${user.status} → ${status === undefined ? user.status : status}${newPassword ? '；已重置密码' : ''}`,
    });
    return ok(res, { id }, '用户已更新');
  })
);

/* ------------------------------------------------------------------ */
/* 审计日志                                                            */
/* ------------------------------------------------------------------ */

router.get(
  '/admin/audit-logs',
  ...sysOnly,
  wrap(async (req, res) => {
    const pageNo = Number(req.query.page) || 1;
    const size = Math.min(Number(req.query.size) || 20, 200);
    const where = ['1 = 1'];
    const params = [];
    if (req.query.action) {
      where.push('a.action = ?');
      params.push(req.query.action);
    }
    if (req.query.username) {
      where.push('a.username LIKE ?');
      params.push(`%${req.query.username}%`);
    }
    if (req.query.result !== undefined && req.query.result !== '') {
      where.push('a.result = ?');
      params.push(Number(req.query.result));
    }
    if (req.query.start) {
      where.push('a.created_at >= ?');
      params.push(String(req.query.start).replace('T', ' '));
    }
    if (req.query.end) {
      where.push('a.created_at <= ?');
      params.push(String(req.query.end).replace('T', ' '));
    }
    const whereSql = where.join(' AND ');
    const totalRow = await db.queryOne(`SELECT COUNT(*) AS total FROM t_audit_log a WHERE ${whereSql}`, params);
    const rows = await db.query(
      `SELECT a.* FROM t_audit_log a WHERE ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      [...params, size, (pageNo - 1) * size]
    );
    const actions = await db.query(`SELECT DISTINCT action FROM t_audit_log ORDER BY action`);
    return ok(res, {
      ...page(rows, Number(totalRow.total), pageNo, size),
      actions: actions.map((a) => a.action),
    });
  })
);

/* ------------------------------------------------------------------ */
/* 运行监控                                                            */
/* ------------------------------------------------------------------ */

router.get(
  '/admin/monitor',
  ...sysOnly,
  wrap(async (req, res) => {
    // 未引入网关排队与 Redis，队列长度与缓存差值恒为 0（对应设计文档 8.3 的可选增强项）
    const snap = metrics.snapshot(0);
    const waiting = await db.queryOne(`SELECT COUNT(*) AS cnt FROM t_waitlist WHERE status = 1`);
    const activeEnroll = await db.queryOne(`SELECT COUNT(*) AS cnt FROM t_enrollment WHERE status = 1`);

    return ok(res, {
      ...snap,
      onlineUsers: sessions.onlineCount(),
      waitlistTotal: Number(waiting.cnt),
      activeEnrollment: Number(activeEnroll.cnt),
      rateLimitConfig: require('../../config/config').rateLimit,
      thresholds: [
        { name: '接口错误率', value: Math.round((100 - snap.successRate) * 100) / 100, unit: '%', threshold: '1%', level: 100 - snap.successRate > 1 ? 'warn' : 'ok' },
        { name: '选课写接口 P95', value: snap.writeP95Ms, unit: 'ms', threshold: '2000ms', level: snap.writeP95Ms > 2000 ? 'warn' : 'ok' },
        { name: '排队队列长度', value: snap.queueLength, unit: '人', threshold: '200 人', level: snap.queueLength > 200 ? 'warn' : 'ok' },
        { name: '缓存与库余量差值', value: snap.cacheDiff, unit: '', threshold: '持续 > 0', level: snap.cacheDiff > 0 ? 'warn' : 'ok' },
      ],
    });
  })
);

module.exports = router;
