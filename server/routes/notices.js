'use strict';

/**
 * 通知中心与公告接口（见设计文档 2.3、表 4）。
 */

const express = require('express');
const db = require('../db');
const { authenticate, wrap } = require('../middleware/auth');
const { ok, page } = require('../utils/response');
const { CODES, AppError } = require('../utils/errors');

const router = express.Router();

const NOTICE_TYPE_TEXT = { 1: '选课结果', 2: '候补递补', 3: '递补失败', 4: '退课', 5: '公告' };

/** 通知列表，支持按类型筛选 */
router.get(
  '/notices',
  authenticate,
  wrap(async (req, res) => {
    const pageNo = Number(req.query.page) || 1;
    const size = Math.min(Number(req.query.size) || 20, 100);
    const where = ['user_id = ?'];
    const params = [req.user.userId];
    if (req.query.type) {
      where.push('type = ?');
      params.push(Number(req.query.type));
    }
    if (String(req.query.unread) === 'true') where.push('is_read = 0');

    const whereSql = where.join(' AND ');
    const totalRow = await db.queryOne(`SELECT COUNT(*) AS total FROM t_notice WHERE ${whereSql}`, params);
    const rows = await db.query(
      `SELECT * FROM t_notice WHERE ${whereSql} ORDER BY is_read ASC, created_at DESC LIMIT ? OFFSET ?`,
      [...params, size, (pageNo - 1) * size]
    );
    const unread = await db.queryOne(
      `SELECT COUNT(*) AS cnt FROM t_notice WHERE user_id = ? AND is_read = 0`,
      [req.user.userId]
    );

    return ok(
      res,
      {
        ...page(
          rows.map((r) => ({ ...r, typeText: NOTICE_TYPE_TEXT[r.type] || '通知' })),
          Number(totalRow.total),
          pageNo,
          size
        ),
        unread: Number(unread.cnt),
      }
    );
  })
);

/** 标记已读 */
router.post(
  '/notices/:id/read',
  authenticate,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const row = await db.queryOne(`SELECT * FROM t_notice WHERE id = ? AND user_id = ?`, [id, req.user.userId]);
    if (!row) throw new AppError(CODES.BAD_REQUEST, '通知不存在');
    await db.execute(`UPDATE t_notice SET is_read = 1 WHERE id = ?`, [id]);
    return ok(res, { id, isRead: true });
  })
);

/** 全部标记已读 */
router.post(
  '/notices/read-all',
  authenticate,
  wrap(async (req, res) => {
    await db.execute(`UPDATE t_notice SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [req.user.userId]);
    return ok(res, { done: true });
  })
);

/** 公告列表（全体可见） */
router.get(
  '/announcements',
  authenticate,
  wrap(async (req, res) => {
    const rows = await db.query(
      `SELECT a.*, u.real_name AS publisher_name FROM t_announcement a
         JOIN t_user u ON u.id = a.publisher_id
        WHERE a.status = 1 ORDER BY a.publish_time DESC LIMIT 20`
    );
    return ok(res, { list: rows });
  })
);

module.exports = router;
