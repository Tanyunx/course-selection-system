'use strict';

/**
 * 选课核心业务（见设计文档 6.1 选课流程、6.2 退课流程、6.3 换课流程、6.5 并发一致性设计）。
 *
 * 并发要点：
 *  - 占用与释放名额一律通过「条件更新」完成，依赖 InnoDB 行锁与 enrolled < capacity 判断，
 *    保证余量不为负；更新影响行数为 0 即视为已满，不做重试（6.5 第一层）。
 *  - 第 5 步（占名额）先于冲突/学分/先修校验执行，用于快速隔离并发竞争；
 *    若后续校验失败，整个事务回滚，已占名额自动归还。
 */

const db = require('../db');
const rules = require('./ruleService');
const notice = require('./notice');
const audit = require('./audit');
const { CODES, AppError } = require('../utils/errors');
const { weekdayText, parityText, scheduleText } = require('./courseService');

/** 取开课基础信息 */
async function getOffering(offeringId, conn = null) {
  const sql = `SELECT o.*, c.name AS course_name, c.course_code, c.credit, c.id AS course_id
                 FROM t_course_offering o
                 JOIN t_course c ON c.id = o.course_id
                WHERE o.id = ?`;
  if (conn) {
    const [rows] = await conn.query(sql, [offeringId]);
    return rows.length ? rows[0] : null;
  }
  return db.queryOne(sql, [offeringId]);
}

/**
 * 条件更新占用名额（最终防线）。
 * UPDATE t_course_offering SET enrolled = enrolled + 1
 *  WHERE id = ? AND enrolled < capacity AND status = 1
 */
async function occupySeat(conn, offeringId) {
  const [r] = await conn.query(
    `UPDATE t_course_offering
        SET enrolled = enrolled + 1
      WHERE id = ? AND enrolled < capacity AND status <> 0`,
    [offeringId]
  );
  if (r.affectedRows === 0) {
    throw new AppError(CODES.COURSE_FULL, undefined, { offeringId });
  }
  await conn.query(
    `UPDATE t_course_offering SET status = 2 WHERE id = ? AND status = 1 AND enrolled >= capacity`,
    [offeringId]
  );
  return true;
}

/** 释放名额并恢复开课状态 */
async function releaseSeat(conn, offeringId) {
  await conn.query(
    `UPDATE t_course_offering SET enrolled = enrolled - 1 WHERE id = ? AND enrolled > 0`,
    [offeringId]
  );
  await conn.query(
    `UPDATE t_course_offering SET status = 1 WHERE id = ? AND status = 2 AND enrolled < capacity`,
    [offeringId]
  );
}

/** 写入选课记录：唯一键冲突时复用该行（保留历史，见 5.3 表 15 说明） */
async function upsertEnrollment(conn, studentId, offeringId, source) {
  await conn.query(
    `INSERT INTO t_enrollment (student_id, offering_id, select_time, status, source, drop_time)
     VALUES (?, ?, NOW(), 1, ?, NULL)
     ON DUPLICATE KEY UPDATE status = 1, select_time = NOW(), source = VALUES(source), drop_time = NULL`,
    [studentId, offeringId, source]
  );
}

/** 冲突结果转文案 */
function conflictText(conflicts) {
  return conflicts
    .map(
      (c) =>
        `《${c.course_name}》${weekdayText(c.weekday)} ${c.start_period}-${c.end_period} 节（${parityText(c.parity)}）`
    )
    .join('；');
}

/**
 * 选课（6.1）。
 * 校验顺序：鉴权 → 幂等 → 批次 → 重复 → 容量占用 → 冲突 → 学分 → 先修 → 落库。
 */
async function enroll(req, student, offeringId) {
  const term = await rules.getCurrentTerm();
  if (!term) throw new AppError(CODES.INTERNAL_ERROR, '系统未配置当前学期');

  const offering = await getOffering(offeringId);
  if (!offering || offering.term_id !== term.id) {
    throw new AppError(CODES.OFFERING_NOT_FOUND);
  }
  if (offering.status === 0) throw new AppError(CODES.OFFERING_CLOSED);

  // 3) 批次准入
  const batch = await rules.assertInBatch(term.id, student);

  // 4) 重复校验
  const dup = await db.queryOne(
    `SELECT status FROM t_enrollment WHERE student_id = ? AND offering_id = ?`,
    [student.id, offeringId]
  );
  if (dup && dup.status === 1) throw new AppError(CODES.ALREADY_ENROLLED);
  const wl = await db.queryOne(
    `SELECT queue_no FROM t_waitlist WHERE student_id = ? AND offering_id = ? AND status = 1`,
    [student.id, offeringId]
  );
  if (wl) {
    throw new AppError(CODES.ALREADY_WAITLISTED, `你已加入候补，当前排位为第 ${wl.queue_no} 位`, {
      queueNo: wl.queue_no,
    });
  }

  let extra = null;
  await db.withTransaction(async (conn) => {
    // 5) 条件更新占名额
    await occupySeat(conn, offeringId);

    // 6) 时间冲突
    const { conflicts, tightTransfers } = await rules.detectConflict(offeringId, student.id, term.id, conn);
    if (conflicts.length) {
      throw new AppError(CODES.TIME_CONFLICT, `与已选课程时间冲突：${conflictText(conflicts)}`, {
        conflicts,
      });
    }

    // 7) 学分与类别
    const creditInfo = await rules.assertCreditNotExceed(student.id, term.id, student.grade, offering.credit, conn);

    // 8) 先修
    await rules.assertPrereqSatisfied(student.id, offering.course_id, conn);

    // 9) 写入选课记录
    await upsertEnrollment(conn, student.id, offeringId, 1);

    extra = {
      credit: creditInfo,
      tightTransfers: tightTransfers.map((t) => ({
        courseName: t.course_name,
        text: `${weekdayText(t.weekday)} ${t.end_period} 节与《${t.course_name}》${t.other_start_period} 节相邻且分处 ${t.campus}/${t.other_campus}`,
      })),
    };
  });

  await notice.send(
    req.user.userId,
    notice.TYPE.ENROLL_RESULT,
    '选课成功',
    `你已成功选修《${offering.course_name}》（${offering.course_code}），${offering.credit} 学分。`,
    offeringId
  );
  await audit.log(req, {
    action: 'ENROLL',
    targetType: 'OFFERING',
    targetId: offeringId,
    result: 1,
    detail: `选课成功：${offering.course_name}；批次=${batch.name}`,
  });

  return {
    offeringId,
    courseName: offering.course_name,
    batch: { id: batch.id, name: batch.name },
    credit: extra.credit,
    tightTransfers: extra.tightTransfers || [],
  };
}

/** 退课（6.2 第一步至第四步） */
async function drop(req, student, offeringId) {
  const term = await rules.getCurrentTerm();
  const offering = await getOffering(offeringId);
  if (!offering || offering.term_id !== term.id) throw new AppError(CODES.OFFERING_NOT_FOUND);

  // 退课截止校验
  const deadline = await rules.assertDropAllowed(term.id);

  await db.withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT * FROM t_enrollment WHERE student_id = ? AND offering_id = ? FOR UPDATE`,
      [student.id, offeringId]
    );
    if (!rows.length || rows[0].status !== 1) throw new AppError(CODES.NOT_ENROLLED);

    await conn.query(
      `UPDATE t_enrollment SET status = 0, drop_time = NOW() WHERE id = ?`,
      [rows[0].id]
    );
    await releaseSeat(conn, offeringId);
  });

  await notice.send(
    req.user.userId,
    notice.TYPE.DROP_RESULT,
    '退课已生效',
    `你已退选《${offering.course_name}》（${offering.course_code}），名额已释放。`,
    offeringId
  );
  await audit.log(req, {
    action: 'DROP',
    targetType: 'OFFERING',
    targetId: offeringId,
    result: 1,
    detail: `退课成功：${offering.course_name}`,
  });

  // 触发候补递补（事务外执行，避免长事务）
  const promote = require('./waitlistService');
  const promoted = await promote.promoteFromOffering(offeringId);

  return {
    offeringId,
    courseName: offering.course_name,
    deadline,
    promoted: promoted.result,
  };
}

/**
 * 换课（6.3 单一事务"先占后放"）。
 * 校验目标开课可选并预占 → 释放原开课名额 → 触发原开课候补递补。
 * 任一步失败整体回滚，原课程与名额不变，返回 2009。
 */
async function switchCourse(req, student, fromOfferingId, toOfferingId) {
  if (Number(fromOfferingId) === Number(toOfferingId)) {
    throw new AppError(CODES.SWITCH_TARGET_INVALID, '原课程与目标课程相同，无需换课');
  }
  const term = await rules.getCurrentTerm();
  const from = await getOffering(fromOfferingId);
  const to = await getOffering(toOfferingId);
  if (!from || !to || from.term_id !== term.id || to.term_id !== term.id) {
    throw new AppError(CODES.OFFERING_NOT_FOUND);
  }
  if (to.status === 0) throw new AppError(CODES.SWITCH_TARGET_INVALID, '目标课程已停开');

  const batch = await rules.assertInBatch(term.id, student);

  try {
    await db.withTransaction(async (conn) => {
      // 1) 校验目标开课可选并预占名额
      const [src] = await conn.query(
        `SELECT * FROM t_enrollment WHERE student_id = ? AND offering_id = ? AND status = 1 FOR UPDATE`,
        [student.id, fromOfferingId]
      );
      if (!src.length) throw new AppError(CODES.NOT_ENROLLED, '你尚未选修原课程，无法换课');

      await occupySeat(conn, toOfferingId);

      // 2) 目标课程规则校验（冲突校验需排除即将释放的原课程）
      const { conflicts } = await rules.detectConflict(
        toOfferingId,
        student.id,
        term.id,
        conn,
        [fromOfferingId]
      );
      if (conflicts.length) {
        throw new AppError(CODES.TIME_CONFLICT, `目标课程与已选课程冲突：${conflictText(conflicts)}`, { conflicts });
      }
      await rules.assertCreditNotExceed(
        student.id,
        term.id,
        student.grade,
        to.credit,
        conn,
        from.credit
      );
      await rules.assertPrereqSatisfied(student.id, to.course_id, conn);

      // 3) 释放原开课名额
      await conn.query(`UPDATE t_enrollment SET status = 0, drop_time = NOW() WHERE id = ?`, [src[0].id]);
      await releaseSeat(conn, fromOfferingId);

      // 4) 写目标选课记录
      await upsertEnrollment(conn, student.id, toOfferingId, 1);
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === CODES.NOT_ENROLLED) throw err;
      throw new AppError(
        CODES.SWITCH_TARGET_INVALID,
        `换课未生效：${err.message}`,
        { reasonCode: err.code, reason: err.message, ...(err.extra || {}) }
      );
    }
    throw err;
  }

  await notice.send(
    req.user.userId,
    notice.TYPE.ENROLL_RESULT,
    '换课成功',
    `已将《${from.course_name}》换为《${to.course_name}》。`,
    toOfferingId
  );
  await audit.log(req, {
    action: 'SWITCH',
    targetType: 'OFFERING',
    targetId: toOfferingId,
    result: 1,
    detail: `换课：${from.course_name} → ${to.course_name}；批次=${batch.name}`,
  });

  const promote = require('./waitlistService');
  const promoted = await promote.promoteFromOffering(fromOfferingId);

  return {
    from: { offeringId: fromOfferingId, courseName: from.course_name },
    to: { offeringId: toOfferingId, courseName: to.course_name },
    promoted: promoted.result,
    tightTransfers: [],
  };
}

/** 我的已选课程 */
async function myEnrollments(student, termId) {
  const rows = await db.query(
    `SELECT e.id AS enrollment_id, e.offering_id, e.select_time, e.source, e.status,
            c.course_code, c.name AS course_name, c.credit, c.description,
            cat.name AS category_name, cat.id AS category_id,
            o.capacity, o.enrolled, o.campus, o.status AS offering_status,
            tu.real_name AS teacher_name, t.title AS teacher_title
       FROM t_enrollment e
       JOIN t_course_offering o ON o.id = e.offering_id
       JOIN t_course c ON c.id = o.course_id
       JOIN t_course_category cat ON cat.id = c.category_id
       JOIN t_teacher t ON t.id = o.teacher_id
       JOIN t_user tu ON tu.id = t.user_id
      WHERE e.student_id = ? AND o.term_id = ? AND e.status = 1
      ORDER BY e.select_time`,
    [student.id, termId]
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.offering_id);
  const sched = await db.query(
    `SELECT * FROM t_course_schedule WHERE offering_id IN (?) ORDER BY weekday, start_period`,
    [ids]
  );
  const map = new Map();
  sched.forEach((s) => {
    if (!map.has(s.offering_id)) map.set(s.offering_id, []);
    map.get(s.offering_id).push(s);
  });
  return rows.map((r) => {
    const list = map.get(r.offering_id) || [];
    return {
      ...r,
      schedules: list,
      scheduleText: list.map((s) => scheduleText(s)),
      placeText: list
        .map((s) => [s.campus, s.building, s.room].filter(Boolean).join(' '))
        .filter(Boolean)
        .join(' / '),
      heat: rules.heatOf(r.enrolled, r.capacity),
    };
  });
}

/** 我的课表（按周视图，支持单双周切换） */
async function timetable(student, termId, parity = null) {
  const list = await myEnrollments(student, termId);
  const cells = [];
  list.forEach((item) => {
    item.schedules.forEach((s) => {
      // parity 参数为 0/1/2 时按单双周过滤：全周课程在任一视图均显示
      if (parity && Number(parity) !== 0 && s.parity !== 0 && s.parity !== Number(parity)) return;
      cells.push({
        offeringId: item.offering_id,
        courseName: item.course_name,
        courseCode: item.course_code,
        teacherName: item.teacher_name,
        credit: item.credit,
        categoryName: item.category_name,
        weekday: s.weekday,
        startPeriod: s.start_period,
        endPeriod: s.end_period,
        parity: s.parity,
        parityText: parityText(s.parity),
        place: [s.campus, s.building, s.room].filter(Boolean).join(' '),
        campus: s.campus,
        source: item.source,
      });
    });
  });

  // 冲突区域提示（同一学生课表内的冲突，正常情况下不应出现，此处作为兜底校验）
  const conflictCells = [];
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      const a = cells[i];
      const b = cells[j];
      if (
        a.weekday === b.weekday &&
        a.startPeriod <= b.endPeriod &&
        b.startPeriod <= a.endPeriod &&
        !((a.parity === 1 && b.parity === 2) || (a.parity === 2 && b.parity === 1))
      ) {
        conflictCells.push([a.offeringId, b.offeringId]);
      }
    }
  }

  const totalCredit = list.reduce((s, x) => s + Number(x.credit), 0);
  return { cells, conflictCells, totalCredit, courseCount: list.length };
}

module.exports = {
  getOffering,
  occupySeat,
  releaseSeat,
  upsertEnrollment,
  enroll,
  drop,
  switchCourse,
  myEnrollments,
  timetable,
};
