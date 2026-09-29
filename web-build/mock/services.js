'use strict';

/**
 * 静态版 · 业务服务层
 * 对应 server/services/courseService.js、enrollmentService.js、waitlistService.js、accountService.js。
 */

/* ================================================================== */
/* 账号与身份（accountService）                                        */
/* ================================================================== */

function getUserById(userId) {
  const u = findById('t_user', userId);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    real_name: u.real_name,
    role: Number(u.role),
    status: Number(u.status),
    last_login_at: u.last_login_at,
  };
}

function getUserByUsername(username) {
  return tbl('t_user').find((u) => u.username === username) || null;
}

function getStudentByUserId(userId) {
  return tbl('t_student').find((s) => Number(s.user_id) === Number(userId)) || null;
}

function getStudentById(studentId) {
  const s = findById('t_student', studentId);
  if (!s) return null;
  const u = findById('t_user', s.user_id);
  return { ...s, real_name: u ? u.real_name : '', username: u ? u.username : '', user_status: u ? Number(u.status) : 1 };
}

function getTeacherByUserId(userId) {
  return tbl('t_teacher').find((t) => Number(t.user_id) === Number(userId)) || null;
}

/** 构造登录后的用户信息体 */
function buildProfile(user) {
  const base = {
    userId: user.id,
    username: user.username,
    realName: user.real_name,
    role: Number(user.role),
  };
  if (Number(user.role) === 1) {
    const s = getStudentByUserId(user.id);
    if (s) {
      Object.assign(base, {
        studentId: s.id,
        studentNo: s.student_no,
        grade: s.grade,
        college: s.college,
        major: s.major,
      });
    }
  } else if (Number(user.role) === 2) {
    const t = getTeacherByUserId(user.id);
    if (t) Object.assign(base, { teacherId: t.id, teacherNo: t.teacher_no, college: t.college, title: t.title });
  }
  return base;
}

/* ================================================================== */
/* 课程查询（courseService）                                           */
/* ================================================================== */

function scheduleText(s) {
  const parity = Number(s.parity) ? `（${parityText(s.parity)}）` : '';
  const place = [s.campus, s.building, s.room].filter(Boolean).join(' ');
  const time = periodRangeText(s.start_period, s.end_period);
  return `${weekdayText(s.weekday)} 第 ${s.start_period}-${s.end_period} 节${
    time ? ` ${time}` : ''
  }${parity}${place ? ' · ' + place : ''}`;
}

/** 为一批开课挂载排课时段 */
function attachSchedules(offerings) {
  if (!offerings.length) return offerings;
  const ids = offerings.map((o) => Number(o.offering_id));
  const rows = tbl('t_course_schedule')
    .filter((s) => ids.includes(Number(s.offering_id)))
    .sort((a, b) => Number(a.weekday) - Number(b.weekday) || Number(a.start_period) - Number(b.start_period));
  const map = new Map();
  rows.forEach((r) => {
    const k = Number(r.offering_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  });
  offerings.forEach((o) => {
    o.schedules = map.get(Number(o.offering_id)) || [];
    o.scheduleText = o.schedules.map(scheduleText);
  });
  return offerings;
}

/** 基础查询：按条件筛选开课（含分页与排序） */
function queryOfferings(opts) {
  const { termId, keyword, categoryId, weekday, available, campus, status, page, size, sort } = opts;
  const pageNo = Number(page) || 1;
  const pageSize = Number(size) || 10;

  let rows = tbl('t_course_offering').filter((o) => Number(o.term_id) === Number(termId));

  const withCourse = rows
    .map((o) => {
      const c = findById('t_course', o.course_id);
      if (!c) return null;
      return { o, c };
    })
    .filter(Boolean);

  let list = withCourse.filter(({ o, c }) => {
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      if (!String(c.name).toLowerCase().includes(kw) && !String(c.course_code).toLowerCase().includes(kw)) return false;
    }
    if (categoryId && Number(c.category_id) !== Number(categoryId)) return false;
    if (campus && String(o.campus) !== String(campus)) return false;
    if (status !== undefined && status !== null && status !== '' && Number(o.status) !== Number(status)) return false;
    if (String(available) === 'true' && !(Number(o.status) === 1 && Number(o.enrolled) < Number(o.capacity))) return false;
    if (weekday) {
      const has = tbl('t_course_schedule').some(
        (s) => Number(s.offering_id) === Number(o.id) && Number(s.weekday) === Number(weekday)
      );
      if (!has) return false;
    }
    return true;
  });

  const sorter =
    sort === 'heat'
      ? (a, b) =>
          Number(b.o.enrolled) / Number(b.o.capacity) - Number(a.o.enrolled) / Number(a.o.capacity) ||
          String(a.c.course_code).localeCompare(String(b.c.course_code))
      : sort === 'enrolled'
      ? (a, b) => Number(b.o.enrolled) - Number(a.o.enrolled) || String(a.c.course_code).localeCompare(String(b.c.course_code))
      : (a, b) => String(a.c.course_code).localeCompare(String(b.c.course_code)) || String(a.c.name).localeCompare(String(b.c.name));

  list = list.sort(sorter);
  const total = list.length;
  const paged = list.slice((pageNo - 1) * pageSize, (pageNo - 1) * pageSize + pageSize);

  const mapped = paged.map(({ o, c }) => {
    const cat = findById('t_course_category', c.category_id);
    const t = findById('t_teacher', o.teacher_id);
    const tu = t ? findById('t_user', t.user_id) : null;
    return {
      offering_id: Number(o.id),
      capacity: Number(o.capacity),
      enrolled: Number(o.enrolled),
      offering_status: Number(o.status),
      offering_campus: o.campus,
      remark: o.remark,
      course_id: Number(c.id),
      course_code: c.course_code,
      course_name: c.name,
      credit: Number(c.credit),
      dept: c.dept,
      description: c.description,
      category_id: Number(c.category_id),
      category_name: cat ? cat.name : '',
      teacher_id: t ? Number(t.id) : null,
      teacher_name: tu ? tu.real_name : '',
      teacher_title: t ? t.title : '',
    };
  });

  return { rows: mapped, total };
}

/** 批量标注选课状态（对应设计文档表 6 的按钮状态） */
function annotateOfferings(offerings, ctx) {
  if (!offerings.length) return offerings;
  const { studentId, termId, batchInfo, creditInfo } = ctx;
  const offeringIds = offerings.map((o) => Number(o.offering_id));

  const selectedMap = new Map();
  tbl('t_enrollment')
    .filter((e) => Number(e.student_id) === Number(studentId) && offeringIds.includes(Number(e.offering_id)))
    .forEach((r) => {
      if (Number(r.status) === 1) selectedMap.set(Number(r.offering_id), r);
    });

  const waitMap = new Map();
  tbl('t_waitlist')
    .filter(
      (w) =>
        Number(w.student_id) === Number(studentId) &&
        offeringIds.includes(Number(w.offering_id)) &&
        Number(w.status) === 1
    )
    .forEach((r) => waitMap.set(Number(r.offering_id), r));

  const waitCountMap = new Map();
  tbl('t_waitlist')
    .filter((w) => offeringIds.includes(Number(w.offering_id)) && Number(w.status) === 1)
    .forEach((w) => {
      const k = Number(w.offering_id);
      waitCountMap.set(k, (waitCountMap.get(k) || 0) + 1);
    });

  const myEnrolledIds = new Set(
    tbl('t_enrollment')
      .filter((e) => Number(e.student_id) === Number(studentId) && Number(e.status) === 1)
      .map((e) => Number(e.offering_id))
  );

  // 冲突映射：本页每门开课 vs 本人已选开课
  const conflictMap = new Map();
  const s1All = tbl('t_course_schedule').filter((s) => offeringIds.includes(Number(s.offering_id)));
  const s2All = tbl('t_course_schedule').filter((s) => myEnrolledIds.has(Number(s.offering_id)));
  s1All.forEach((s1) => {
    s2All.forEach((s2) => {
      if (Number(s1.offering_id) === Number(s2.offering_id)) return;
      if (Number(s2.weekday) !== Number(s1.weekday)) return;
      const parityExclusive =
        (Number(s1.parity) === 1 && Number(s2.parity) === 2) || (Number(s1.parity) === 2 && Number(s2.parity) === 1);
      if (parityExclusive) return;
      if (!(Number(s1.start_period) <= Number(s2.end_period) && Number(s2.start_period) <= Number(s1.end_period))) return;

      const o2 = findById('t_course_offering', s2.offering_id);
      if (!o2 || Number(o2.term_id) !== Number(termId)) return;
      const c2 = findById('t_course', o2.course_id);
      if (!c2) return;
      const k = Number(s1.offering_id);
      if (!conflictMap.has(k)) conflictMap.set(k, []);
      const list = conflictMap.get(k);
      if (list.some((x) => x.courseCode === c2.course_code && x.weekday === Number(s1.weekday))) return;
      list.push({
        courseName: c2.name,
        courseCode: c2.course_code,
        weekday: Number(s1.weekday),
        weekdayText: weekdayText(s1.weekday),
        parityText: parityText(s1.parity),
        otherParityText: parityText(s2.parity),
        periods: `${s1.start_period}-${s1.end_period} 节`,
        otherPeriods: `${s2.start_period}-${s2.end_period} 节`,
        campus: s1.campus,
        otherCampus: s2.campus,
      });
    });
  });

  // 先修满足情况：一次性取本页课程的全部先修要求
  const courseIds = [...new Set(offerings.map((o) => Number(o.course_id)))];
  const prereqMap = new Map();
  tbl('t_course_prereq')
    .filter((p) => courseIds.includes(Number(p.course_id)))
    .forEach((p) => {
      const c = findById('t_course', p.prereq_course_id);
      const h = tbl('t_student_course_history').find(
        (x) => Number(x.course_id) === Number(p.prereq_course_id) && Number(x.student_id) === Number(studentId)
      );
      const k = Number(p.course_id);
      if (!prereqMap.has(k)) prereqMap.set(k, []);
      prereqMap.get(k).push({
        require_type: Number(p.require_type),
        group_no: Number(p.group_no),
        prereq_name: c ? c.name : '',
        course_code: c ? c.course_code : '',
        passed: h ? Number(h.is_passed) : 0,
      });
    });

  function prereqMiss(courseId) {
    const rows = prereqMap.get(Number(courseId)) || [];
    if (!rows.length) return [];
    const miss = [];
    rows
      .filter((r) => r.require_type === 1)
      .forEach((r) => {
        if (!r.passed) miss.push(r.prereq_name);
      });
    const groups = new Map();
    rows
      .filter((r) => r.require_type === 2)
      .forEach((r) => {
        if (!groups.has(r.group_no)) groups.set(r.group_no, []);
        groups.get(r.group_no).push(r);
      });
    groups.forEach((g) => {
      if (!g.some((x) => x.passed)) g.forEach((x) => miss.push(x.prereq_name));
    });
    return [...new Set(miss)];
  }

  const batchOk = !!batchInfo.batch;
  const maxCredit = creditInfo.rule ? Number(creditInfo.rule.max_credit) : null;

  offerings.forEach((o) => {
    const selected = selectedMap.get(Number(o.offering_id));
    const wait = waitMap.get(Number(o.offering_id));
    const conflicts = conflictMap.get(Number(o.offering_id)) || [];
    const missPrereq = prereqMiss(o.course_id);
    const willTotal = creditInfo.total + Number(o.credit);
    const creditExceed = maxCredit !== null && willTotal > maxCredit;
    const full = Number(o.enrolled) >= Number(o.capacity) || Number(o.offering_status) === 2;
    const closed = Number(o.offering_status) === 0;

    const reasons = [];
    if (conflicts.length) {
      reasons.push({
        code: 2002,
        text: `与《${conflicts[0].courseName}》冲突（${conflicts[0].weekdayText} ${conflicts[0].periods}）`,
      });
    }
    if (creditExceed) reasons.push({ code: 2003, text: `选后将达 ${willTotal} 学分，超出上限 ${maxCredit}` });
    if (missPrereq.length) reasons.push({ code: 2004, text: `需先修：${missPrereq.join('、')}` });
    if (!batchOk) reasons.push({ code: 2005, text: '当前不在你的选课批次时间内' });
    if (full) reasons.push({ code: 2001, text: '名额已满，可加入候补' });

    let statusText = 'AVAILABLE';
    if (closed) statusText = 'CLOSED';
    else if (selected) statusText = 'SELECTED';
    else if (wait) statusText = 'WAITLISTED';
    else if (!batchOk) statusText = 'OUT_OF_BATCH';
    else if (full) statusText = 'FULL';
    else if (conflicts.length) statusText = 'CONFLICT';
    else if (creditExceed || missPrereq.length) statusText = 'INELIGIBLE';

    o.status = statusText;
    o.selectable = statusText === 'AVAILABLE';
    o.waitlistable = (statusText === 'FULL' || statusText === 'CLOSED') && !selected && !wait;
    o.willTotalCredit = willTotal;
    o.heat = heatOf(o.enrolled, o.capacity);
    o.reasons = reasons;
    o.conflicts = conflicts;
    o.missingPrereq = missPrereq;
    o.myEnrollment = selected
      ? { status: Number(selected.status), source: Number(selected.source), selectTime: selected.select_time }
      : null;
    o.myWaitlist = wait ? { queueNo: Number(wait.queue_no), status: Number(wait.status) } : null;
    o.waitlistCount = waitCountMap.get(Number(o.offering_id)) || 0;
    o.remaining = Math.max(0, Number(o.capacity) - Number(o.enrolled));
  });

  return offerings;
}

/** 组装学生侧的选课上下文（批次、学分、先修） */
function buildStudentContext(student, termId) {
  const batchInfo = resolveBatch(termId, student);
  const creditInfo = getCreditSummary(student.id, termId);
  const rule = getCreditRule(termId, student.grade);
  const categoryRules = getCategoryCreditRules(termId);
  const dropDeadline = getDropDeadline(termId);
  return {
    studentId: Number(student.id),
    student,
    termId: Number(termId),
    batchInfo,
    creditInfo: { ...creditInfo, rule },
    categoryRules,
    dropDeadline,
  };
}

/** 开课详情：含排课、余量、热度、先修要求、候补队列 */
function getOfferingDetail(offeringId, ctx) {
  const o = findById('t_course_offering', offeringId);
  if (!o || Number(o.term_id) !== Number(ctx.termId)) return null;
  const c = findById('t_course', o.course_id);
  const cat = findById('t_course_category', c.category_id);
  const t = findById('t_teacher', o.teacher_id);
  const tu = t ? findById('t_user', t.user_id) : null;

  const row = {
    offering_id: Number(o.id),
    capacity: Number(o.capacity),
    enrolled: Number(o.enrolled),
    offering_status: Number(o.status),
    offering_campus: o.campus,
    remark: o.remark,
    course_id: Number(c.id),
    course_code: c.course_code,
    course_name: c.name,
    credit: Number(c.credit),
    dept: c.dept,
    description: c.description,
    category_id: Number(c.category_id),
    category_name: cat ? cat.name : '',
    teacher_id: t ? Number(t.id) : null,
    teacher_name: tu ? tu.real_name : '',
    teacher_title: t ? t.title : '',
    teacher_college: t ? t.college : '',
  };

  const rows = [row];
  attachSchedules(rows);
  annotateOfferings(rows, ctx);

  const detailed = rows[0];
  detailed.prereqList = tbl('t_course_prereq')
    .filter((p) => Number(p.course_id) === Number(c.id))
    .map((p) => {
      const pc = findById('t_course', p.prereq_course_id);
      const h = tbl('t_student_course_history').find(
        (x) => Number(x.course_id) === Number(p.prereq_course_id) && Number(x.student_id) === Number(ctx.studentId)
      );
      return {
        name: pc ? pc.name : '',
        code: pc ? pc.course_code : '',
        requireType: Number(p.require_type),
        groupNo: Number(p.group_no),
        passed: !!(h && Number(h.is_passed)),
      };
    });

  detailed.waitlistQueue = tbl('t_waitlist')
    .filter((w) => Number(w.offering_id) === Number(offeringId) && Number(w.status) === 1)
    .sort((a, b) => Number(a.queue_no) - Number(b.queue_no))
    .slice(0, 10)
    .map((w) => {
      const s = getStudentById(w.student_id);
      return { queueNo: Number(w.queue_no), studentNo: s ? s.student_no : '', name: s ? s.real_name : '' };
    });

  return detailed;
}

/* ================================================================== */
/* 选课 / 退课 / 换课（enrollmentService）                             */
/* ================================================================== */

/** 取开课基础信息 */
function getOffering(offeringId) {
  const o = findById('t_course_offering', offeringId);
  if (!o) return null;
  const c = findById('t_course', o.course_id);
  if (!c) return null;
  return {
    ...o,
    course_name: c.name,
    course_code: c.course_code,
    credit: Number(c.credit),
    course_id: Number(c.id),
  };
}

/**
 * 条件更新占用名额（最终防线）。
 * 数据库版依靠 InnoDB 行锁保证余量不为负；内存版为单线程，语义等价：
 * 只有 enrolled < capacity 且未停开时才自增，否则视为已满。
 */
function occupySeat(offeringId) {
  const o = findById('t_course_offering', offeringId);
  if (!o || Number(o.status) === 0 || Number(o.enrolled) >= Number(o.capacity)) {
    throw new AppError(CODES.COURSE_FULL, undefined, { offeringId: Number(offeringId) });
  }
  o.enrolled = Number(o.enrolled) + 1;
  o.updated_at = now();
  if (Number(o.status) === 1 && Number(o.enrolled) >= Number(o.capacity)) o.status = 2;
  return true;
}

function releaseSeat(offeringId) {
  const o = findById('t_course_offering', offeringId);
  if (!o) return;
  if (Number(o.enrolled) > 0) o.enrolled = Number(o.enrolled) - 1;
  if (Number(o.status) === 2 && Number(o.enrolled) < Number(o.capacity)) o.status = 1;
  o.updated_at = now();
}

/** 写入选课记录：唯一键冲突时复用该行 */
function upsertEnrollment(studentId, offeringId, source) {
  const exist = tbl('t_enrollment').find(
    (e) => Number(e.student_id) === Number(studentId) && Number(e.offering_id) === Number(offeringId)
  );
  if (exist) {
    exist.status = 1;
    exist.select_time = now();
    exist.source = Number(source);
    exist.drop_time = null;
    exist.updated_at = now();
    return exist;
  }
  return insert('t_enrollment', {
    student_id: Number(studentId),
    offering_id: Number(offeringId),
    select_time: now(),
    status: 1,
    source: Number(source),
    drop_time: null,
  });
}

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
 * 与数据库版一致：先占名额再校验，任一步失败则回滚（此处手动归还名额）。
 */
function enroll(payload, student, offeringId) {
  const term = getCurrentTerm();
  if (!term) throw new AppError(CODES.INTERNAL_ERROR, '系统未配置当前学期');

  const offering = getOffering(offeringId);
  if (!offering || Number(offering.term_id) !== Number(term.id)) throw new AppError(CODES.OFFERING_NOT_FOUND);
  if (Number(offering.status) === 0) throw new AppError(CODES.OFFERING_CLOSED);

  const batch = assertInBatch(term.id, student);

  const dup = tbl('t_enrollment').find(
    (e) => Number(e.student_id) === Number(student.id) && Number(e.offering_id) === Number(offeringId)
  );
  if (dup && Number(dup.status) === 1) throw new AppError(CODES.ALREADY_ENROLLED);

  const wl = tbl('t_waitlist').find(
    (w) =>
      Number(w.student_id) === Number(student.id) &&
      Number(w.offering_id) === Number(offeringId) &&
      Number(w.status) === 1
  );
  if (wl) {
    throw new AppError(CODES.ALREADY_WAITLISTED, `你已加入候补，当前排位为第 ${wl.queue_no} 位`, {
      queueNo: Number(wl.queue_no),
    });
  }

  let extra;
  occupySeat(offeringId);
  try {
    const { conflicts, tightTransfers } = detectConflict(offeringId, student.id, term.id, []);
    if (conflicts.length) {
      throw new AppError(CODES.TIME_CONFLICT, `与已选课程时间冲突：${conflictText(conflicts)}`, { conflicts });
    }
    const creditInfo = assertCreditNotExceed(student.id, term.id, student.grade, offering.credit, 0);
    assertPrereqSatisfied(student.id, offering.course_id);
    upsertEnrollment(student.id, offeringId, 1);
    extra = {
      credit: creditInfo,
      tightTransfers: tightTransfers.map((t) => ({
        courseName: t.course_name,
        text: `${weekdayText(t.weekday)} ${t.end_period} 节与《${t.course_name}》${t.other_start_period} 节相邻且分处 ${t.campus}/${t.other_campus}`,
      })),
    };
  } catch (err) {
    releaseSeat(offeringId); // 回滚已占名额
    throw err;
  }

  sendNotice(
    payload.user.userId,
    NOTICE_TYPE.ENROLL_RESULT,
    '选课成功',
    `你已成功选修《${offering.course_name}》（${offering.course_code}），${offering.credit} 学分。`,
    offeringId
  );
  logAudit(payload, {
    action: 'ENROLL',
    targetType: 'OFFERING',
    targetId: offeringId,
    result: 1,
    detail: `选课成功：${offering.course_name}；批次=${batch.name}`,
  });

  return {
    offeringId: Number(offeringId),
    courseName: offering.course_name,
    batch: { id: Number(batch.id), name: batch.name },
    credit: extra.credit,
    tightTransfers: extra.tightTransfers || [],
  };
}

/** 退课（6.2） */
function drop(payload, student, offeringId) {
  const term = getCurrentTerm();
  const offering = getOffering(offeringId);
  if (!offering || Number(offering.term_id) !== Number(term.id)) throw new AppError(CODES.OFFERING_NOT_FOUND);

  const deadline = assertDropAllowed(term.id);

  const row = tbl('t_enrollment').find(
    (e) => Number(e.student_id) === Number(student.id) && Number(e.offering_id) === Number(offeringId)
  );
  if (!row || Number(row.status) !== 1) throw new AppError(CODES.NOT_ENROLLED);

  row.status = 0;
  row.drop_time = now();
  row.updated_at = now();
  releaseSeat(offeringId);

  sendNotice(
    payload.user.userId,
    NOTICE_TYPE.DROP_RESULT,
    '退课已生效',
    `你已退选《${offering.course_name}》（${offering.course_code}），名额已释放。`,
    offeringId
  );
  logAudit(payload, {
    action: 'DROP',
    targetType: 'OFFERING',
    targetId: offeringId,
    result: 1,
    detail: `退课成功：${offering.course_name}`,
  });

  const promoted = promoteFromOffering(offeringId);

  return {
    offeringId: Number(offeringId),
    courseName: offering.course_name,
    deadline,
    promoted: promoted.result,
  };
}

/**
 * 换课（6.3 单一事务「先占后放」）。
 * 校验目标开课可选并预占 → 释放原开课名额 → 触发原开课候补递补。
 * 任一步失败整体回滚，原课程与名额不变，返回 2009。
 */
function switchCourse(payload, student, fromOfferingId, toOfferingId) {
  if (Number(fromOfferingId) === Number(toOfferingId)) {
    throw new AppError(CODES.SWITCH_TARGET_INVALID, '原课程与目标课程相同，无需换课');
  }
  const term = getCurrentTerm();
  const from = getOffering(fromOfferingId);
  const to = getOffering(toOfferingId);
  if (!from || !to || Number(from.term_id) !== Number(term.id) || Number(to.term_id) !== Number(term.id)) {
    throw new AppError(CODES.OFFERING_NOT_FOUND);
  }
  if (Number(to.status) === 0) throw new AppError(CODES.SWITCH_TARGET_INVALID, '目标课程已停开');

  const batch = assertInBatch(term.id, student);

  const src = tbl('t_enrollment').find(
    (e) =>
      Number(e.student_id) === Number(student.id) &&
      Number(e.offering_id) === Number(fromOfferingId) &&
      Number(e.status) === 1
  );
  if (!src) throw new AppError(CODES.NOT_ENROLLED, '你尚未选修原课程，无法换课');

  try {
    occupySeat(toOfferingId);
    const { conflicts } = detectConflict(toOfferingId, student.id, term.id, [fromOfferingId]);
    if (conflicts.length) {
      throw new AppError(CODES.TIME_CONFLICT, `目标课程与已选课程冲突：${conflictText(conflicts)}`, { conflicts });
    }
    assertCreditNotExceed(student.id, term.id, student.grade, to.credit, from.credit);
    assertPrereqSatisfied(student.id, to.course_id);

    src.status = 0;
    src.drop_time = now();
    src.updated_at = now();
    releaseSeat(fromOfferingId);
    upsertEnrollment(student.id, toOfferingId, 1);
  } catch (err) {
    if (err instanceof AppError) {
      // 归还已预占的目标名额（原课程此时尚未释放）
      releaseSeat(toOfferingId);
      if (err.code === CODES.NOT_ENROLLED) throw err;
      throw new AppError(CODES.SWITCH_TARGET_INVALID, `换课未生效：${err.message}`, {
        reasonCode: err.code,
        reason: err.message,
        ...(err.extra || {}),
      });
    }
    releaseSeat(toOfferingId);
    throw err;
  }

  sendNotice(
    payload.user.userId,
    NOTICE_TYPE.ENROLL_RESULT,
    '换课成功',
    `已将《${from.course_name}》换为《${to.course_name}》。`,
    toOfferingId
  );
  logAudit(payload, {
    action: 'SWITCH',
    targetType: 'OFFERING',
    targetId: toOfferingId,
    result: 1,
    detail: `换课：${from.course_name} → ${to.course_name}；批次=${batch.name}`,
  });

  const promoted = promoteFromOffering(fromOfferingId);

  return {
    from: { offeringId: Number(fromOfferingId), courseName: from.course_name },
    to: { offeringId: Number(toOfferingId), courseName: to.course_name },
    promoted: promoted.result,
    tightTransfers: [],
  };
}

/** 我的已选课程 */
function myEnrollments(student, termId) {
  const rows = tbl('t_enrollment')
    .filter((e) => Number(e.student_id) === Number(student.id) && Number(e.status) === 1)
    .map((e) => {
      const o = findById('t_course_offering', e.offering_id);
      if (!o || Number(o.term_id) !== Number(termId)) return null;
      const c = findById('t_course', o.course_id);
      const cat = findById('t_course_category', c.category_id);
      const t = findById('t_teacher', o.teacher_id);
      const tu = t ? findById('t_user', t.user_id) : null;
      return {
        enrollment_id: Number(e.id),
        offering_id: Number(e.offering_id),
        select_time: e.select_time,
        source: Number(e.source),
        status: Number(e.status),
        course_code: c.course_code,
        course_name: c.name,
        credit: Number(c.credit),
        description: c.description,
        category_name: cat ? cat.name : '',
        category_id: Number(c.category_id),
        capacity: Number(o.capacity),
        enrolled: Number(o.enrolled),
        campus: o.campus,
        offering_status: Number(o.status),
        teacher_name: tu ? tu.real_name : '',
        teacher_title: t ? t.title : '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.select_time).localeCompare(String(b.select_time)));

  return rows.map((r) => {
    const list = tbl('t_course_schedule')
      .filter((s) => Number(s.offering_id) === Number(r.offering_id))
      .sort((a, b) => Number(a.weekday) - Number(b.weekday) || Number(a.start_period) - Number(b.start_period));
    return {
      ...r,
      schedules: list,
      scheduleText: list.map((s) => scheduleText(s)),
      placeText: list
        .map((s) => [s.campus, s.building, s.room].filter(Boolean).join(' '))
        .filter(Boolean)
        .join(' / '),
      heat: heatOf(r.enrolled, r.capacity),
    };
  });
}

/** 我的课表（按周视图，支持单双周切换） */
function timetable(student, termId, parity) {
  const list = myEnrollments(student, termId);
  const cells = [];
  list.forEach((item) => {
    item.schedules.forEach((s) => {
      if (parity && Number(parity) !== 0 && Number(s.parity) !== 0 && Number(s.parity) !== Number(parity)) return;
      cells.push({
        offeringId: Number(item.offering_id),
        courseName: item.course_name,
        courseCode: item.course_code,
        teacherName: item.teacher_name,
        credit: item.credit,
        categoryName: item.category_name,
        weekday: Number(s.weekday),
        startPeriod: Number(s.start_period),
        endPeriod: Number(s.end_period),
        parity: Number(s.parity),
        parityText: parityText(s.parity),
        place: [s.campus, s.building, s.room].filter(Boolean).join(' '),
        campus: s.campus,
        source: item.source,
      });
    });
  });

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

/* ================================================================== */
/* 候补与自动递补（waitlistService）                                   */
/* ================================================================== */

const WAIT_STATUS = { WAITING: 1, PROMOTED: 2, CANCELED: 3, INVALID: 4 };

/** 加入候补 */
function joinWaitlist(payload, student, offeringId) {
  const term = getCurrentTerm();
  const offering = getOffering(offeringId);
  if (!offering || Number(offering.term_id) !== Number(term.id)) throw new AppError(CODES.OFFERING_NOT_FOUND);

  assertInBatch(term.id, student);

  const selected = tbl('t_enrollment').find(
    (e) =>
      Number(e.student_id) === Number(student.id) &&
      Number(e.offering_id) === Number(offeringId) &&
      Number(e.status) === 1
  );
  if (selected) throw new AppError(CODES.ALREADY_ENROLLED);

  const exist = tbl('t_waitlist').find(
    (w) => Number(w.student_id) === Number(student.id) && Number(w.offering_id) === Number(offeringId)
  );
  if (exist && Number(exist.status) === WAIT_STATUS.WAITING) {
    throw new AppError(CODES.ALREADY_WAITLISTED, `你已加入候补，当前排位为第 ${exist.queue_no} 位`, {
      queueNo: Number(exist.queue_no),
    });
  }
  if (exist && Number(exist.status) === WAIT_STATUS.PROMOTED) {
    throw new AppError(CODES.ALREADY_ENROLLED, '你已通过候补递补获得该课程名额');
  }

  assertPrereqSatisfied(student.id, offering.course_id);

  const maxNo = tbl('t_waitlist')
    .filter((w) => Number(w.offering_id) === Number(offeringId))
    .reduce((m, w) => Math.max(m, Number(w.queue_no) || 0), 0);
  const queueNo = maxNo + 1;

  if (exist) {
    exist.queue_no = queueNo;
    exist.join_time = now();
    exist.status = 1;
    exist.expire_time = null;
    exist.updated_at = now();
  } else {
    insert('t_waitlist', {
      student_id: Number(student.id),
      offering_id: Number(offeringId),
      queue_no: queueNo,
      join_time: now(),
      status: 1,
      expire_time: null,
    });
  }

  sendNotice(
    payload.user.userId,
    NOTICE_TYPE.WAITLIST_PROMOTED,
    '已加入候补',
    `你已加入《${offering.course_name}》候补队列，当前排位第 ${queueNo} 位，名额释放后将按排位自动递补。`,
    offeringId
  );
  logAudit(payload, {
    action: 'WAITLIST_JOIN',
    targetType: 'OFFERING',
    targetId: offeringId,
    result: 1,
    detail: `加入候补：${offering.course_name}，排位 ${queueNo}`,
  });

  return {
    offeringId: Number(offeringId),
    courseName: offering.course_name,
    queueNo,
    queueCount: countWaiting(offeringId),
  };
}

/** 取消候补 */
function cancelWaitlist(payload, student, offeringId) {
  const row = tbl('t_waitlist').find(
    (w) => Number(w.student_id) === Number(student.id) && Number(w.offering_id) === Number(offeringId)
  );
  if (!row || Number(row.status) !== WAIT_STATUS.WAITING) throw new AppError(CODES.NOT_WAITLISTED);
  row.status = 3;
  row.updated_at = now();
  logAudit(payload, {
    action: 'WAITLIST_CANCEL',
    targetType: 'OFFERING',
    targetId: offeringId,
    result: 1,
    detail: '取消候补',
  });
  return { offeringId: Number(offeringId), queueNo: Number(row.queue_no) };
}

/** 我的候补列表 */
function myWaitlist(student, termId) {
  const rows = tbl('t_waitlist')
    .filter((w) => Number(w.student_id) === Number(student.id) && [1, 2].includes(Number(w.status)))
    .map((w) => {
      const o = findById('t_course_offering', w.offering_id);
      if (!o || Number(o.term_id) !== Number(termId)) return null;
      const c = findById('t_course', o.course_id);
      const cat = findById('t_course_category', c.category_id);
      const t = findById('t_teacher', o.teacher_id);
      const tu = t ? findById('t_user', t.user_id) : null;
      return {
        id: Number(w.id),
        offering_id: Number(w.offering_id),
        queue_no: Number(w.queue_no),
        join_time: w.join_time,
        status: Number(w.status),
        expire_time: w.expire_time,
        course_code: c.course_code,
        course_name: c.name,
        credit: Number(c.credit),
        category_name: cat ? cat.name : '',
        capacity: Number(o.capacity),
        enrolled: Number(o.enrolled),
        offering_status: Number(o.status),
        campus: o.campus,
        teacher_name: tu ? tu.real_name : '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.join_time).localeCompare(String(b.join_time)));

  return rows.map((r) => {
    const waiting = tbl('t_waitlist').filter(
      (w) => Number(w.offering_id) === Number(r.offering_id) && Number(w.status) === 1
    );
    const minNo = waiting.reduce((m, w) => Math.min(m, Number(w.queue_no)), r.queue_no);
    return {
      ...r,
      heat: heatOf(r.enrolled, r.capacity),
      waitingCount: waiting.length,
      aheadCount: Number(r.status) === 1 ? Math.max(0, Number(r.queue_no) - minNo) : 0,
      statusText: Number(r.status) === 1 ? '候补中' : '已递补',
    };
  });
}

function countWaiting(offeringId) {
  return tbl('t_waitlist').filter(
    (w) => Number(w.offering_id) === Number(offeringId) && Number(w.status) === 1
  ).length;
}

/**
 * 名额释放后的自动递补主流程。
 * 取排位最靠前的候补学生 → 重新执行完整选课校验 → 通过则递补，不通过则置为失效并顺延。
 */
function promoteFromOffering(offeringId) {
  const trace = [];
  const MAX_ITER = 20;

  const term = getCurrentTerm();
  const offering = getOffering(offeringId);
  if (!offering || !term) return { result: trace };

  for (let i = 0; i < MAX_ITER; i += 1) {
    const off = findById('t_course_offering', offeringId);
    if (!off || Number(off.status) === 0 || Number(off.enrolled) >= Number(off.capacity)) {
      return { result: trace, stopReason: '名额已被占满或开课已停开' };
    }

    const cands = tbl('t_waitlist')
      .filter((w) => Number(w.offering_id) === Number(offeringId) && Number(w.status) === 1)
      .sort((a, b) => Number(a.queue_no) - Number(b.queue_no));
    if (!cands.length) return { result: trace };
    const cand = cands[0];

    const student = getStudentById(cand.student_id);

    try {
      const batch = assertInBatch(term.id, student, new Date());
      const { conflicts } = detectConflict(offeringId, student.id, term.id, []);
      if (conflicts.length) {
        throw new AppError(CODES.TIME_CONFLICT, `与已选课程时间冲突：${conflictText(conflicts)}`, { conflicts });
      }
      assertCreditNotExceed(student.id, term.id, student.grade, offering.credit, 0);
      assertPrereqSatisfied(student.id, offering.course_id);

      occupySeat(offeringId);
      upsertEnrollment(student.id, offeringId, 2);

      const expire = new Date(Date.now() + CONFIG.business.waitlistConfirmHours * 3600 * 1000);
      cand.status = 2;
      cand.expire_time = fmtDateTime(expire);
      cand.updated_at = now();

      sendNotice(
        student.user_id,
        NOTICE_TYPE.WAITLIST_PROMOTED,
        '候补递补成功',
        `你候补的《${offering.course_name}》已递补成功，请于 ${fmt(expire)} 前确认。`,
        offeringId
      );

      trace.push({
        action: 'PROMOTED',
        studentNo: student.student_no,
        studentName: student.real_name,
        queueNo: Number(cand.queue_no),
        batch: batch.name,
        expireTime: fmtDateTime(expire),
      });
      return { result: trace };
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      cand.status = 4;
      cand.updated_at = now();
      sendNotice(
        student.user_id,
        NOTICE_TYPE.WAITLIST_FAILED,
        '候补递补失败',
        `你候补的《${offering.course_name}》本次递补未通过校验（${err.message}），名额已顺延下一位。`,
        offeringId
      );
      trace.push({
        action: 'INVALID',
        studentNo: student.student_no,
        studentName: student.real_name,
        queueNo: Number(cand.queue_no),
        reason: err.message,
        reasonCode: err.code,
      });
    }
  }

  return { result: trace, stopReason: '达到单次递补处理上限' };
}

/** 确认递补名额 */
function confirmWaitlist(payload, student, offeringId) {
  const row = tbl('t_waitlist').find(
    (w) => Number(w.student_id) === Number(student.id) && Number(w.offering_id) === Number(offeringId)
  );
  if (!row || Number(row.status) !== WAIT_STATUS.PROMOTED) {
    throw new AppError(CODES.NOT_WAITLISTED, '你没有待确认的递补名额');
  }
  row.expire_time = null;
  row.updated_at = now();
  logAudit(payload, {
    action: 'WAITLIST_CONFIRM',
    targetType: 'OFFERING',
    targetId: offeringId,
    result: 1,
    detail: '确认候补递补名额',
  });
  return { offeringId: Number(offeringId), confirmed: true };
}

/* ------------------------------------------------------------------ */

module.exports = {
  getUserById,
  getUserByUsername,
  getStudentByUserId,
  getStudentById,
  getTeacherByUserId,
  buildProfile,
  scheduleText,
  attachSchedules,
  queryOfferings,
  annotateOfferings,
  buildStudentContext,
  getOfferingDetail,
  getOffering,
  occupySeat,
  releaseSeat,
  upsertEnrollment,
  enroll,
  drop,
  switchCourse,
  myEnrollments,
  timetable,
  WAIT_STATUS,
  joinWaitlist,
  cancelWaitlist,
  myWaitlist,
  countWaiting,
  promoteFromOffering,
  confirmWaitlist,
};
