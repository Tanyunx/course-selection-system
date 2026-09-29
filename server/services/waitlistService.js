'use strict';

/**
 * 候补与自动递补（见设计文档 4.6、6.2）。
 *
 * 递补规则：
 *  1) 取该开课候补队列中状态为「候补中」且 queue_no 最小的一名学生；
 *  2) 对该生重新执行完整的选课校验（批次、容量、时间冲突、学分、先修）；
 *  3) 校验通过：生成选课记录（来源标记为「候补递补」），占用名额，候补记录置为「已递补」，
 *     发送通知并设置确认截止时间；
 *  4) 校验不通过：候补记录置为「已失效」，发送「候补失败」通知，继续顺延下一名；
 *  5) 确认截止前未确认则释放名额并继续顺延。
 */

const db = require('../db');
const config = require('../../config/config');
const rules = require('./ruleService');
const notice = require('./notice');
const { CODES, AppError } = require('../utils/errors');
const { weekdayText, parityText } = require('./courseService');

const WAIT_STATUS = { WAITING: 1, PROMOTED: 2, CANCELED: 3, INVALID: 4 };

function conflictText(conflicts) {
  return conflicts
    .map(
      (c) =>
        `《${c.course_name}》${weekdayText(c.weekday)} ${c.start_period}-${c.end_period} 节（${parityText(c.parity)}）`
    )
    .join('；');
}

/** 加入候补 */
async function join(req, student, offeringId) {
  const term = await rules.getCurrentTerm();
  const offering = await db.queryOne(
    `SELECT o.*, c.name AS course_name, c.course_code, c.credit
       FROM t_course_offering o JOIN t_course c ON c.id = o.course_id
      WHERE o.id = ?`,
    [offeringId]
  );
  if (!offering || offering.term_id !== term.id) throw new AppError(CODES.OFFERING_NOT_FOUND);

  await rules.assertInBatch(term.id, student);

  const selected = await db.queryOne(
    `SELECT status FROM t_enrollment WHERE student_id = ? AND offering_id = ? AND status = 1`,
    [student.id, offeringId]
  );
  if (selected) throw new AppError(CODES.ALREADY_ENROLLED);

  const exist = await db.queryOne(
    `SELECT * FROM t_waitlist WHERE student_id = ? AND offering_id = ?`,
    [student.id, offeringId]
  );
  if (exist && exist.status === WAIT_STATUS.WAITING) {
    throw new AppError(CODES.ALREADY_WAITLISTED, `你已加入候补，当前排位为第 ${exist.queue_no} 位`, {
      queueNo: exist.queue_no,
    });
  }
  if (exist && exist.status === WAIT_STATUS.PROMOTED) {
    throw new AppError(CODES.ALREADY_ENROLLED, '你已通过候补递补获得该课程名额');
  }

  // 先修校验：不满足者不允许进入候补队列（递补时会再次校验）
  await rules.assertPrereqSatisfied(student.id, offering.course_id);

  const queueNo = await db.withTransaction(async (conn) => {
    const [maxRows] = await conn.query(
      `SELECT IFNULL(MAX(queue_no), 0) AS maxNo FROM t_waitlist WHERE offering_id = ? FOR UPDATE`,
      [offeringId]
    );
    const nextNo = Number(maxRows[0].maxNo) + 1;
    await conn.query(
      `INSERT INTO t_waitlist (student_id, offering_id, queue_no, join_time, status)
       VALUES (?, ?, ?, NOW(), 1)
       ON DUPLICATE KEY UPDATE queue_no = VALUES(queue_no), join_time = NOW(), status = 1, expire_time = NULL`,
      [student.id, offeringId, nextNo]
    );
    return nextNo;
  });

  await notice.send(
    req.user.userId,
    notice.TYPE.WAITLIST_PROMOTED,
    '已加入候补',
    `你已加入《${offering.course_name}》候补队列，当前排位第 ${queueNo} 位，名额释放后将按排位自动递补。`,
    offeringId
  );
  await auditSafe(req, 'WAITLIST_JOIN', offeringId, `加入候补：${offering.course_name}，排位 ${queueNo}`);

  return {
    offeringId,
    courseName: offering.course_name,
    queueNo,
    queueCount: await countWaiting(offeringId),
  };
}

/** 取消候补 */
async function cancel(req, student, offeringId) {
  const row = await db.queryOne(
    `SELECT * FROM t_waitlist WHERE student_id = ? AND offering_id = ?`,
    [student.id, offeringId]
  );
  if (!row || row.status !== WAIT_STATUS.WAITING) throw new AppError(CODES.NOT_WAITLISTED);

  await db.execute(`UPDATE t_waitlist SET status = 3 WHERE id = ?`, [row.id]);
  await auditSafe(req, 'WAITLIST_CANCEL', offeringId, '取消候补');
  return { offeringId, queueNo: row.queue_no };
}

/** 我的候补列表 */
async function mine(student, termId) {
  const rows = await db.query(
    `SELECT w.id, w.offering_id, w.queue_no, w.join_time, w.status, w.expire_time,
            c.course_code, c.name AS course_name, c.credit, cat.name AS category_name,
            o.capacity, o.enrolled, o.status AS offering_status, o.campus,
            tu.real_name AS teacher_name
       FROM t_waitlist w
       JOIN t_course_offering o ON o.id = w.offering_id AND o.term_id = ?
       JOIN t_course c ON c.id = o.course_id
       JOIN t_course_category cat ON cat.id = c.category_id
       JOIN t_teacher t ON t.id = o.teacher_id
       JOIN t_user tu ON tu.id = t.user_id
      WHERE w.student_id = ? AND w.status IN (1, 2)
      ORDER BY w.join_time`,
    [termId, student.id]
  );
  if (!rows.length) return [];

  const ahead = await db.query(
    `SELECT offering_id, COUNT(*) AS cnt FROM t_waitlist
      WHERE offering_id IN (?) AND status = 1 GROUP BY offering_id`,
    [rows.map((r) => r.offering_id)]
  );
  const aheadMap = new Map(ahead.map((a) => [a.offering_id, Number(a.cnt)]));
  const waitRows = await db.query(
    `SELECT offering_id, MIN(queue_no) AS minNo FROM t_waitlist
      WHERE offering_id IN (?) AND status = 1 GROUP BY offering_id`,
    [rows.map((r) => r.offering_id)]
  );
  const minMap = new Map(waitRows.map((a) => [a.offering_id, Number(a.minNo)]));

  return rows.map((r) => ({
    ...r,
    heat: rules.heatOf(r.enrolled, r.capacity),
    waitingCount: aheadMap.get(r.offering_id) || 0,
    aheadCount: r.status === 1 ? Math.max(0, r.queue_no - (minMap.get(r.offering_id) || r.queue_no)) : 0,
    statusText: r.status === 1 ? '候补中' : '已递补',
  }));
}

async function countWaiting(offeringId) {
  const r = await db.queryOne(
    `SELECT COUNT(*) AS cnt FROM t_waitlist WHERE offering_id = ? AND status = 1`,
    [offeringId]
  );
  return Number(r.cnt);
}

async function auditSafe(req, action, targetId, detail) {
  try {
    await require('./audit').log(req, {
      action,
      targetType: 'OFFERING',
      targetId,
      result: 1,
      detail,
    });
  } catch (_) {
    /* 审计失败不影响主流程 */
  }
}

/**
 * 名额释放后的自动递补主流程。
 * @returns {{result: Array}} 递补过程记录，供前端与审计展示
 */
async function promoteFromOffering(offeringId) {
  const trace = [];
  const MAX_ITER = 20;

  const term = await rules.getCurrentTerm();
  const offering = await db.queryOne(
    `SELECT o.*, c.name AS course_name, c.course_code, c.credit, c.id AS course_id
       FROM t_course_offering o JOIN t_course c ON c.id = o.course_id
      WHERE o.id = ?`,
    [offeringId]
  );
  if (!offering || !term) return { result: trace };

  for (let i = 0; i < MAX_ITER; i += 1) {
    const outcome = await db.withTransaction(async (conn) => {
      const [offRows] = await conn.query(
        `SELECT * FROM t_course_offering WHERE id = ? FOR UPDATE`,
        [offeringId]
      );
      const off = offRows[0];
      if (!off || off.status === 0 || off.enrolled >= off.capacity) {
        return { action: 'STOP', reason: '名额已被占满或开课已停开' };
      }

      const [cands] = await conn.query(
        `SELECT * FROM t_waitlist WHERE offering_id = ? AND status = 1 ORDER BY queue_no LIMIT 1 FOR UPDATE`,
        [offeringId]
      );
      if (!cands.length) return { action: 'EMPTY' };
      const cand = cands[0];

      const [sRows] = await conn.query(
        `SELECT s.*, u.id AS uid FROM t_student s JOIN t_user u ON u.id = s.user_id WHERE s.id = ?`,
        [cand.student_id]
      );
      const student = sRows[0];

      // 重新执行完整选课校验（全部读取都走事务连接，避免占用连接池导致互相等待）
      try {
        const batch = await rules.assertInBatch(term.id, student, new Date(), conn);
        const { conflicts } = await rules.detectConflict(offeringId, student.id, term.id, conn);
        if (conflicts.length) {
          throw new AppError(CODES.TIME_CONFLICT, `与已选课程时间冲突：${conflictText(conflicts)}`, { conflicts });
        }
        await rules.assertCreditNotExceed(student.id, term.id, student.grade, offering.credit, conn);
        await rules.assertPrereqSatisfied(student.id, offering.course_id, conn);

        // 校验通过：占名额、生成选课记录、置为已递补
        const [upd] = await conn.query(
          `UPDATE t_course_offering SET enrolled = enrolled + 1
            WHERE id = ? AND enrolled < capacity AND status <> 0`,
          [offeringId]
        );
        if (upd.affectedRows === 0) return { action: 'STOP', reason: '名额已被抢占' };
        await conn.query(
          `UPDATE t_course_offering SET status = 2 WHERE id = ? AND status = 1 AND enrolled >= capacity`,
          [offeringId]
        );
        const [enr] = await conn.query(
          `INSERT INTO t_enrollment (student_id, offering_id, select_time, status, source, drop_time)
           VALUES (?, ?, NOW(), 1, 2, NULL)
           ON DUPLICATE KEY UPDATE status = 1, select_time = NOW(), source = 2, drop_time = NULL`,
          [student.id, offeringId]
        );
        const expire = new Date(Date.now() + config.business.waitlistConfirmHours * 3600 * 1000);
        await conn.query(
          `UPDATE t_waitlist SET status = 2, expire_time = ? WHERE id = ?`,
          [expire.toISOString().slice(0, 19).replace('T', ' '), cand.id]
        );
        await notice.send(
          student.user_id,
          notice.TYPE.WAITLIST_PROMOTED,
          '候补递补成功',
          `你候补的《${offering.course_name}》已递补成功，请于 ${rules.fmt(expire)} 前确认。`,
          offeringId,
          conn
        );
        return {
          action: 'PROMOTED',
          studentNo: student.student_no,
          studentName: student.real_name,
          queueNo: cand.queue_no,
          batch: batch.name,
          expireTime: expire,
          enrollmentId: enr.insertId,
        };
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        // 校验不通过：置为已失效，发送通知，继续顺延下一名
        await conn.query(`UPDATE t_waitlist SET status = 4 WHERE id = ?`, [cand.id]);
        await notice.send(
          student.user_id,
          notice.TYPE.WAITLIST_FAILED,
          '候补递补失败',
          `你候补的《${offering.course_name}》本次递补未通过校验（${err.message}），名额已顺延下一位。`,
          offeringId,
          conn
        );
        return {
          action: 'INVALID',
          studentNo: student.student_no,
          studentName: student.real_name,
          queueNo: cand.queue_no,
          reason: err.message,
          reasonCode: err.code,
        };
      }
    });

    if (outcome.action === 'EMPTY' || outcome.action === 'STOP') {
      return { result: trace, stopReason: outcome.reason || null };
    }
    trace.push(outcome);
    if (outcome.action === 'PROMOTED') return { result: trace };
  }
  return { result: trace, stopReason: '达到单次递补处理上限' };
}

/** 确认递补名额（清除确认截止时间） */
async function confirm(req, student, offeringId) {
  const row = await db.queryOne(
    `SELECT * FROM t_waitlist WHERE student_id = ? AND offering_id = ?`,
    [student.id, offeringId]
  );
  if (!row || row.status !== WAIT_STATUS.PROMOTED) throw new AppError(CODES.NOT_WAITLISTED, '你没有待确认的递补名额');
  await db.execute(`UPDATE t_waitlist SET expire_time = NULL WHERE id = ?`, [row.id]);
  await auditSafe(req, 'WAITLIST_CONFIRM', offeringId, '确认候补递补名额');
  return { offeringId, confirmed: true };
}

/**
 * 超时未确认的名额回收（4.6 第 5 条，可选实现）。
 * 定时扫描：确认截止时间已过仍未确认的递补记录，回收名额并继续顺延。
 */
async function sweepExpired() {
  const rows = await db.query(
    `SELECT id, student_id, offering_id, queue_no FROM t_waitlist
      WHERE status = 2 AND expire_time IS NOT NULL AND expire_time < NOW()`
  );
  for (const r of rows) {
    await db.execute(`UPDATE t_waitlist SET status = 4 WHERE id = ?`, [r.id]);
    const seat = await db.queryOne(
      `SELECT id FROM t_enrollment WHERE student_id = ? AND offering_id = ? AND status = 1`,
      [r.student_id, r.offering_id]
    );
    if (seat) {
      await db.execute(`UPDATE t_enrollment SET status = 0, drop_time = NOW() WHERE id = ?`, [seat.id]);
      await db.execute(
        `UPDATE t_course_offering SET enrolled = enrolled - 1 WHERE id = ? AND enrolled > 0`,
        [r.offering_id]
      );
      await db.execute(
        `UPDATE t_course_offering SET status = 1 WHERE id = ? AND status = 2 AND enrolled < capacity`,
        [r.offering_id]
      );
      await promoteFromOffering(r.offering_id);
    }
  }
  return rows.length;
}

module.exports = {
  WAIT_STATUS,
  join,
  cancel,
  mine,
  confirm,
  promoteFromOffering,
  sweepExpired,
  countWaiting,
};
