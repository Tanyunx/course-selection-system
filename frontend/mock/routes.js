'use strict';

/**
 * 静态版 · 接口路由分发
 *
 * 复刻数据库版 Express 的各路由模块（auth / courses / enrollments / waitlist /
 * notices / teacher / admin / sys），保持路径、入参、返回体与错误码完全一致，
 * 因此前端页面代码无需任何改动即可直接运行。
 */

const ROLE = { STUDENT: 1, TEACHER: 2, ACADEMIC_ADMIN: 3, SYS_ADMIN: 4 };
const ROLE_TEXT = { 1: '学生', 2: '教师', 3: '教务管理员', 4: '系统管理员' };

/** 演示环境登录口令（编码存放，避免明文散落在源码中） */
const DEMO_SECRET = (typeof atob === 'function' ? atob('MTIzNDU2') : '123456');

function page(list, total, pageNo, size) {
  return { total, page: pageNo, size, list };
}

function reg(pattern) {
  return pattern.split('/').map((seg) => (seg.startsWith(':') ? { param: seg.slice(1) } : seg));
}

function matchPath(pattern, path) {
  const pp = reg(pattern);
  const ap = path.split('/');
  if (pp.length !== ap.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i += 1) {
    const seg = pp[i];
    if (typeof seg === 'object') params[seg.param] = decodeURIComponent(ap[i]);
    else if (seg !== ap[i]) return null;
  }
  return params;
}

/** 取学生档案 */
function requireStudent(user) {
  const s = getStudentByUserId(user.userId);
  if (!s) throw new AppError(CODES.FORBIDDEN, '未找到学生档案，请联系教务管理员');
  return s;
}

function requireTeacher(user) {
  const t = getTeacherByUserId(user.userId);
  if (!t) throw new AppError(CODES.FORBIDDEN, '未找到教师档案，请联系教务管理员');
  return t;
}

/* ================================================================== */
/* 路由表                                                              */
/* ================================================================== */

const ROUTES = [];
function route(method, path, roles, handler, opts) {
  ROUTES.push({ method, path, roles: roles || null, handler, opts: opts || {} });
}

/* ---------------------------- 健康检查 ---------------------------- */

route('GET', '/api/health', null, async () => ({
  data: { status: 'ok', mode: 'static', tables: Object.keys(DATA).length },
}));

/* ---------------------------- 认证 -------------------------------- */

route('GET', '/api/auth/captcha', null, async () => {
  const a = randomInt(2, 19);
  const b = randomInt(1, 9);
  const plus = randomInt(0, 1) === 1;
  const answer = plus ? a + b : a - b;
  const id = randomId();
  captchas.set(id, { answer, expire: Date.now() + 3 * 60 * 1000 });
  return { data: { captchaId: id, question: `${a} ${plus ? '+' : '−'} ${b} = ?` } };
});

route('POST', '/api/auth/login', null, async (ctx) => {
  const { username, password, captchaId, captchaAnswer } = ctx.body || {};
  if (!username || !password) throw new AppError(CODES.BAD_REQUEST, '请输入账号与密码');

  const failures = loginFailures.get(username) || 0;
  if (failures >= CONFIG.auth.captchaAfterFailures) {
    const item = captchaId ? captchas.get(captchaId) : null;
    const valid = item && item.expire > Date.now() && Number(captchaAnswer) === item.answer;
    if (captchaId) captchas.delete(captchaId);
    if (!valid) return { code: CODES.AUTH_FAILED, message: '请输入正确的验证码', data: { needCaptcha: true } };
  }

  const user = getUserByUsername(username);
  if (!user || password !== DEMO_SECRET) {
    const c = failures + 1;
    loginFailures.set(username, c);
    logAudit({ user: null, ip: ctx.ip }, {
      action: 'LOGIN',
      targetType: 'USER',
      result: 0,
      detail: `账号或密码错误：${username}（连续失败 ${c} 次）`,
    });
    return {
      code: CODES.AUTH_FAILED,
      message: MESSAGES[CODES.AUTH_FAILED],
      data: { needCaptcha: c >= CONFIG.auth.captchaAfterFailures },
    };
  }
  if (Number(user.status) !== 1) {
    return { code: CODES.FORBIDDEN, message: '账号已被禁用，请联系系统管理员', data: null };
  }

  loginFailures.delete(username);
  user.last_login_at = now();
  user.updated_at = now();

  const profile = buildProfile(user);
  const jti = randomId();
  createSession({ jti, userId: user.id, username: user.username, realName: user.real_name, role: Number(user.role) });

  logAudit({ user: { userId: user.id, username: user.username }, ip: ctx.ip }, {
    action: 'LOGIN',
    targetType: 'USER',
    targetId: user.id,
    result: 1,
    detail: '登录成功',
  });

  return {
    data: {
      token: jti,
      expiresInMinutes: CONFIG.auth.idleTimeoutMinutes,
      profile,
    },
  };
});

route('POST', '/api/auth/logout', 'any', async (ctx) => {
  sessions.delete(ctx.user.jti);
  return { data: { logout: true } };
});

route('GET', '/api/auth/me', 'any', async (ctx) => {
  const user = getUserById(ctx.user.userId);
  const profile = buildProfile(user);
  const unread = tbl('t_notice').filter((n) => Number(n.user_id) === Number(ctx.user.userId) && Number(n.is_read) === 0);
  return { data: { profile, unreadNotice: unread.length } };
});

/* ---------------------------- 课程 -------------------------------- */

route('GET', '/api/terms/current', 'any', async () => {
  const current = getCurrentTerm();
  const terms = [...tbl('t_term')].sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
  return { data: { current, terms } };
});

route('GET', '/api/meta/filters', 'any', async () => {
  const categories = [...tbl('t_course_category')].sort((a, b) => Number(a.id) - Number(b.id));
  const campuses = [
    ...new Set(
      tbl('t_course_offering')
        .map((o) => o.campus)
        .filter((c) => c !== null && c !== undefined && c !== '')
    ),
  ].sort();
  return {
    data: {
      categories: categories.map((c) => ({ value: Number(c.id), label: c.name, code: c.code })),
      campuses,
      weekdays: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: weekdayText(n) })),
      parities: [
        { value: 0, label: '全周' },
        { value: 1, label: '单周' },
        { value: 2, label: '双周' },
      ],
    },
  };
});

route('GET', '/api/courses', 'any', async (ctx) => {
  const currentTerm = getCurrentTerm();
  const termId = Number(ctx.query.termId) || (currentTerm ? currentTerm.id : null);
  const pageNo = Number(ctx.query.page) || 1;
  const size = Math.min(Number(ctx.query.size) || 10, 50);

  const { rows, total } = queryOfferings({
    termId,
    keyword: ctx.query.keyword,
    categoryId: ctx.query.categoryId,
    weekday: ctx.query.weekday,
    available: ctx.query.available,
    campus: ctx.query.campus,
    status: ctx.query.status,
    page: pageNo,
    size,
    sort: ctx.query.sort,
  });

  attachSchedules(rows);

  if (Number(ctx.user.role) === ROLE.STUDENT) {
    const student = getStudentByUserId(ctx.user.userId);
    if (student) {
      const c = buildStudentContext(student, termId);
      annotateOfferings(rows, c);
    }
  }

  return {
    data: page(
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
    ),
  };
});

route('GET', '/api/courses/:offeringId', 'any', async (ctx) => {
  const offeringId = Number(ctx.params.offeringId);
  const currentTerm = getCurrentTerm();

  if (Number(ctx.user.role) === ROLE.STUDENT) {
    const student = getStudentByUserId(ctx.user.userId);
    if (!student) throw new AppError(CODES.FORBIDDEN, '未找到学生档案');
    const c = buildStudentContext(student, currentTerm.id);
    const detail = getOfferingDetail(offeringId, c);
    if (!detail) throw new AppError(CODES.OFFERING_NOT_FOUND);
    return {
      data: {
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
          batch: c.batchInfo.batch,
          nextBatch: c.batchInfo.next,
          credit: c.creditInfo,
          categoryRules: c.categoryRules,
          dropDeadline: c.dropDeadline,
        },
      },
    };
  }

  const o = findById('t_course_offering', offeringId);
  if (!o) throw new AppError(CODES.OFFERING_NOT_FOUND);
  const c = findById('t_course', o.course_id);
  const cat = findById('t_course_category', c.category_id);
  const t = findById('t_teacher', o.teacher_id);
  const tu = t ? findById('t_user', t.user_id) : null;
  const schedules = tbl('t_course_schedule')
    .filter((s) => Number(s.offering_id) === offeringId)
    .sort((a, b) => Number(a.weekday) - Number(b.weekday) || Number(a.start_period) - Number(b.start_period));

  return {
    data: {
      offering: {
        offeringId: Number(o.id),
        courseCode: c.course_code,
        courseName: c.name,
        credit: Number(c.credit),
        categoryName: cat ? cat.name : '',
        dept: c.dept,
        description: c.description,
        teacherName: tu ? tu.real_name : '',
        teacherTitle: t ? t.title : '',
        capacity: Number(o.capacity),
        enrolled: Number(o.enrolled),
        remaining: Math.max(0, Number(o.capacity) - Number(o.enrolled)),
        heat: heatOf(o.enrolled, o.capacity),
        campus: o.campus,
        remark: o.remark,
        schedules,
        scheduleText: schedules.map(scheduleText),
        prereqList: [],
        waitlistQueue: [],
      },
    },
  };
});

/* ---------------------------- 选课 / 退课 / 换课 -------------------- */

const studentOnly = [ROLE.STUDENT];

route('POST', '/api/enrollments', studentOnly, async (ctx) => {
  const offeringId = Number(ctx.body && ctx.body.offeringId);
  if (!offeringId) throw new AppError(CODES.BAD_REQUEST, '缺少 offeringId');
  const data = enroll(ctx, ctx.student, offeringId);
  return { data, message: '选课成功' };
}, { rateLimited: true, idempotent: true });

route('DELETE', '/api/enrollments/:offeringId', studentOnly, async (ctx) => {
  const offeringId = Number(ctx.params.offeringId);
  const data = drop(ctx, ctx.student, offeringId);
  const msg = data.promoted && data.promoted.length ? '退课成功，名额已递补给候补同学' : '退课成功';
  return { data, message: msg };
}, { rateLimited: true, idempotent: true });

route('POST', '/api/enrollments/switch', studentOnly, async (ctx) => {
  const from = Number(ctx.body && ctx.body.fromOfferingId);
  const to = Number(ctx.body && ctx.body.toOfferingId);
  if (!from || !to) throw new AppError(CODES.BAD_REQUEST, '缺少 fromOfferingId 或 toOfferingId');
  const data = switchCourse(ctx, ctx.student, from, to);
  return { data, message: '换课成功' };
}, { rateLimited: true, idempotent: true });

route('GET', '/api/enrollments/mine', studentOnly, async (ctx) => {
  const term = getCurrentTerm();
  const termId = Number(ctx.query.termId) || term.id;
  const list = myEnrollments(ctx.student, termId);
  const c = buildStudentContext(ctx.student, termId);
  return {
    data: {
      list,
      totalCredit: c.creditInfo.total,
      byCategory: c.creditInfo.byCategory,
      creditRule: c.creditInfo.rule,
      categoryRules: c.categoryRules,
      batch: c.batchInfo.batch,
      nextBatch: c.batchInfo.next,
      dropDeadline: c.dropDeadline,
    },
  };
});

route('GET', '/api/timetable', studentOnly, async (ctx) => {
  const term = getCurrentTerm();
  const termId = Number(ctx.query.termId) || term.id;
  const parity = ctx.query.parity === undefined ? null : Number(ctx.query.parity);
  const data = timetable(ctx.student, termId, parity);
  const c = buildStudentContext(ctx.student, termId);
  return {
    data: {
      ...data,
      weekdays: [1, 2, 3, 4, 5, 6, 7].map((n) => weekdayText(n)),
      creditRule: c.creditInfo.rule,
    },
  };
});

/* ---------------------------- 候补 -------------------------------- */

route('POST', '/api/waitlist', studentOnly, async (ctx) => {
  const offeringId = Number(ctx.body && ctx.body.offeringId);
  if (!offeringId) throw new AppError(CODES.BAD_REQUEST, '缺少 offeringId');
  const data = joinWaitlist(ctx, ctx.student, offeringId);
  return { data, message: `已加入候补，当前排位第 ${data.queueNo} 位` };
}, { rateLimited: true, idempotent: true });

route('DELETE', '/api/waitlist/:offeringId', studentOnly, async (ctx) => {
  const data = cancelWaitlist(ctx, ctx.student, Number(ctx.params.offeringId));
  return { data, message: '已取消候补' };
}, { idempotent: true });

route('POST', '/api/waitlist/:offeringId/confirm', studentOnly, async (ctx) => {
  const data = confirmWaitlist(ctx, ctx.student, Number(ctx.params.offeringId));
  return { data, message: '已确认递补名额' };
});

route('GET', '/api/waitlist/mine', studentOnly, async (ctx) => {
  const term = getCurrentTerm();
  const termId = Number(ctx.query.termId) || term.id;
  const list = myWaitlist(ctx.student, termId);
  return { data: { list, waitlistConfirmHours: CONFIG.business.waitlistConfirmHours } };
});

/* ---------------------------- 通知与公告 ---------------------------- */

route('GET', '/api/notices', 'any', async (ctx) => {
  const pageNo = Number(ctx.query.page) || 1;
  const size = Math.min(Number(ctx.query.size) || 20, 100);
  let rows = tbl('t_notice').filter((n) => Number(n.user_id) === Number(ctx.user.userId));
  if (ctx.query.type) rows = rows.filter((n) => Number(n.type) === Number(ctx.query.type));
  if (String(ctx.query.unread) === 'true') rows = rows.filter((n) => Number(n.is_read) === 0);

  const total = rows.length;
  const sorted = [...rows].sort((a, b) => {
    const r = Number(a.is_read) - Number(b.is_read);
    if (r !== 0) return r;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
  const list = sorted.slice((pageNo - 1) * size, (pageNo - 1) * size + size);
  const unread = tbl('t_notice').filter(
    (n) => Number(n.user_id) === Number(ctx.user.userId) && Number(n.is_read) === 0
  );

  return {
    data: {
      ...page(
        list.map((r) => ({ ...r, typeText: NOTICE_TYPE_TEXT[r.type] || '通知' })),
        total,
        pageNo,
        size
      ),
      unread: unread.length,
    },
  };
});

route('POST', '/api/notices/:id/read', 'any', async (ctx) => {
  const id = Number(ctx.params.id);
  const row = tbl('t_notice').find((n) => Number(n.id) === id && Number(n.user_id) === Number(ctx.user.userId));
  if (!row) throw new AppError(CODES.BAD_REQUEST, '通知不存在');
  row.is_read = 1;
  row.updated_at = now();
  return { data: { id, isRead: true } };
});

route('POST', '/api/notices/read-all', 'any', async (ctx) => {
  tbl('t_notice')
    .filter((n) => Number(n.user_id) === Number(ctx.user.userId) && Number(n.is_read) === 0)
    .forEach((n) => {
      n.is_read = 1;
      n.updated_at = now();
    });
  return { data: { done: true } };
});

route('GET', '/api/announcements', 'any', async () => {
  const list = tbl('t_announcement')
    .filter((a) => Number(a.status) === 1)
    .sort((a, b) => String(b.publish_time).localeCompare(String(a.publish_time)))
    .slice(0, 20)
    .map((a) => {
      const u = findById('t_user', a.publisher_id);
      return { ...a, publisher_name: u ? u.real_name : '' };
    });
  return { data: { list } };
});

/* ---------------------------- 教师端 -------------------------------- */

const teacherOnly = [ROLE.TEACHER, ROLE.ACADEMIC_ADMIN];

route('GET', '/api/teacher/offerings', teacherOnly, async (ctx) => {
  const term = getCurrentTerm();
  let teacherIds;
  if (Number(ctx.user.role) === ROLE.TEACHER) {
    const t = getTeacherByUserId(ctx.user.userId);
    if (!t) throw new AppError(CODES.FORBIDDEN, '未找到教师档案');
    teacherIds = [Number(t.id)];
  } else {
    teacherIds = tbl('t_teacher').map((t) => Number(t.id));
  }

  const rows = tbl('t_course_offering')
    .filter((o) => Number(o.term_id) === Number(term.id) && teacherIds.includes(Number(o.teacher_id)))
    .map((o) => {
      const c = findById('t_course', o.course_id);
      const cat = findById('t_course_category', c.category_id);
      const t = findById('t_teacher', o.teacher_id);
      const tu = t ? findById('t_user', t.user_id) : null;
      return {
        offering_id: Number(o.id),
        capacity: Number(o.capacity),
        enrolled: Number(o.enrolled),
        status: Number(o.status),
        campus: o.campus,
        remark: o.remark,
        course_code: c.course_code,
        course_name: c.name,
        credit: Number(c.credit),
        category_name: cat ? cat.name : '',
        teacher_name: tu ? tu.real_name : '',
      };
    })
    .sort((a, b) => String(a.course_code).localeCompare(String(b.course_code)));

  attachSchedules(rows);

  const countMap = new Map();
  tbl('t_waitlist')
    .filter((w) => Number(w.status) === 1 && rows.some((r) => r.offering_id === Number(w.offering_id)))
    .forEach((w) => {
      const k = Number(w.offering_id);
      countMap.set(k, (countMap.get(k) || 0) + 1);
    });

  return {
    data: {
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
        heat: heatOf(r.enrolled, r.capacity),
        status: r.status,
        campus: r.campus,
        remark: r.remark,
        schedules: r.schedules,
        scheduleText: r.scheduleText,
        waitlistCount: countMap.get(r.offering_id) || 0,
      })),
    },
  };
});

route('PUT', '/api/teacher/offerings/:id', teacherOnly, async (ctx) => {
  const offeringId = Number(ctx.params.id);
  const offering = findById('t_course_offering', offeringId);
  if (!offering) throw new AppError(CODES.OFFERING_NOT_FOUND);

  if (Number(ctx.user.role) === ROLE.TEACHER) {
    const t = getTeacherByUserId(ctx.user.userId);
    if (!t || Number(t.id) !== Number(offering.teacher_id)) {
      throw new AppError(CODES.FORBIDDEN, '只能维护本人的开课');
    }
  }

  const schedules = Array.isArray(ctx.body && ctx.body.schedules) ? ctx.body.schedules : [];
  assertValidSchedules(schedules);

  removeWhere('t_course_schedule', { offering_id: offeringId });
  schedules.forEach((s) => {
    insert('t_course_schedule', {
      offering_id: offeringId,
      weekday: Number(s.weekday),
      start_period: Number(s.startPeriod),
      end_period: Number(s.endPeriod),
      parity: Number(s.parity || 0),
      campus: s.campus || null,
      building: s.building || null,
      room: s.room || null,
    });
  });
  if (ctx.body && ctx.body.remark !== undefined) {
    offering.remark = String(ctx.body.remark).slice(0, 200);
    offering.updated_at = now();
  }

  logAudit(ctx, {
    action: 'TEACHER_UPDATE_SCHEDULE',
    targetType: 'OFFERING',
    targetId: offeringId,
    result: 1,
    detail: `维护排课：共 ${schedules.length} 个时段`,
  });
  return { data: { offeringId, scheduleCount: schedules.length }, message: '上课时间与地点已保存' };
});

route('GET', '/api/teacher/offerings/:id/students', teacherOnly, async (ctx) => {
  const offeringId = Number(ctx.params.id);
  const offering = findById('t_course_offering', offeringId);
  if (!offering) throw new AppError(CODES.OFFERING_NOT_FOUND);
  if (Number(ctx.user.role) === ROLE.TEACHER) {
    const t = getTeacherByUserId(ctx.user.userId);
    if (!t || Number(t.id) !== Number(offering.teacher_id)) throw new AppError(CODES.FORBIDDEN, '只能查看本人开课名单');
  }

  const students = tbl('t_enrollment')
    .filter((e) => Number(e.offering_id) === offeringId && Number(e.status) === 1)
    .sort((a, b) => String(a.select_time).localeCompare(String(b.select_time)))
    .map((e) => {
      const s = findById('t_student', e.student_id);
      const u = s ? findById('t_user', s.user_id) : null;
      return {
        student_no: s ? s.student_no : '',
        real_name: u ? u.real_name : '',
        grade: s ? s.grade : '',
        college: s ? s.college : '',
        major: s ? s.major : '',
        select_time: e.select_time,
        source: Number(e.source),
        source_text: Number(e.source) === 2 ? '候补递补' : '正常选课',
      };
    });

  const waitlist = tbl('t_waitlist')
    .filter((w) => Number(w.offering_id) === offeringId && [1, 2].includes(Number(w.status)))
    .sort((a, b) => Number(a.queue_no) - Number(b.queue_no))
    .map((w) => {
      const s = findById('t_student', w.student_id);
      const u = s ? findById('t_user', s.user_id) : null;
      return {
        queue_no: Number(w.queue_no),
        student_no: s ? s.student_no : '',
        real_name: u ? u.real_name : '',
        join_time: w.join_time,
        status: Number(w.status),
      };
    });

  return {
    data: {
      students,
      waitlist,
      capacity: Number(offering.capacity),
      enrolled: Number(offering.enrolled),
    },
  };
});

/* ---------------------------- 教务管理端 ---------------------------- */

const academicOnly = [ROLE.ACADEMIC_ADMIN];

route('GET', '/api/admin/dashboard', academicOnly, async () => {
  const term = getCurrentTerm();
  const offerings = tbl('t_course_offering').filter((o) => Number(o.term_id) === Number(term.id) && Number(o.status) !== 0);
  const totalCapacity = offerings.reduce((s, o) => s + Number(o.capacity), 0);
  const totalEnrolled = offerings.reduce((s, o) => s + Number(o.enrolled), 0);

  const offeringIds = new Set(tbl('t_course_offering').filter((o) => Number(o.term_id) === Number(term.id)).map((o) => Number(o.id)));
  const enrollCount = tbl('t_enrollment').filter((e) => Number(e.status) === 1 && offeringIds.has(Number(e.offering_id))).length;
  const waitCount = tbl('t_waitlist').filter((w) => Number(w.status) === 1 && offeringIds.has(Number(w.offering_id))).length;

  const hot = offerings
    .map((o) => {
      const c = findById('t_course', o.course_id);
      return {
        offering_id: Number(o.id),
        course_name: c ? c.name : '',
        course_code: c ? c.course_code : '',
        capacity: Number(o.capacity),
        enrolled: Number(o.enrolled),
        rate: Number(o.capacity) ? Math.round((Number(o.enrolled) / Number(o.capacity)) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 8);

  const full = tbl('t_course_offering').filter(
    (o) => Number(o.term_id) === Number(term.id) && Number(o.enrolled) >= Number(o.capacity)
  );
  const batches = tbl('t_enroll_batch')
    .filter((b) => Number(b.term_id) === Number(term.id))
    .sort((a, b) => Number(a.priority) - Number(b.priority));

  return {
    data: {
      term,
      offeringCount: offerings.length,
      totalCapacity,
      totalEnrolled,
      utilization: totalCapacity ? Math.round((totalEnrolled / totalCapacity) * 1000) / 10 : 0,
      enrollCount,
      waitCount,
      studentCount: tbl('t_student').length,
      fullCount: full.length,
      hotCourses: hot,
      batches,
    },
  };
});

/* --- 课程目录 --- */

route('GET', '/api/admin/courses', academicOnly, async (ctx) => {
  const pageNo = Number(ctx.query.page) || 1;
  const size = Math.min(Number(ctx.query.size) || 20, 100);

  let rows = tbl('t_course').filter((c) => {
    if (ctx.query.keyword) {
      const kw = String(ctx.query.keyword).toLowerCase();
      if (!String(c.name).toLowerCase().includes(kw) && !String(c.course_code).toLowerCase().includes(kw)) return false;
    }
    if (ctx.query.categoryId && Number(c.category_id) !== Number(ctx.query.categoryId)) return false;
    return true;
  });

  const total = rows.length;
  const sorted = [...rows].sort((a, b) => String(a.course_code).localeCompare(String(b.course_code)));
  const list = sorted.slice((pageNo - 1) * size, (pageNo - 1) * size + size).map((c) => {
    const cat = findById('t_course_category', c.category_id);
    return {
      ...c,
      credit: Number(c.credit),
      category_name: cat ? cat.name : '',
      offering_count: tbl('t_course_offering').filter((o) => Number(o.course_id) === Number(c.id)).length,
      prereq_count: tbl('t_course_prereq').filter((p) => Number(p.course_id) === Number(c.id)).length,
    };
  });

  return { data: page(list, total, pageNo, size) };
});

route('POST', '/api/admin/courses', academicOnly, async (ctx) => {
  const { courseCode, name, categoryId, credit, dept, description } = ctx.body || {};
  if (!courseCode || !name || !categoryId || credit === undefined) {
    throw new AppError(CODES.BAD_REQUEST, '课程代码、名称、类别与学分为必填项');
  }
  if (tbl('t_course').some((c) => c.course_code === courseCode)) {
    throw new AppError(CODES.BAD_REQUEST, `课程代码 ${courseCode} 已存在`);
  }
  const r = insert('t_course', {
    course_code: courseCode,
    name,
    category_id: Number(categoryId),
    credit: Number(credit),
    dept: dept || null,
    description: description || null,
    status: 1,
  });
  logAudit(ctx, { action: 'COURSE_CREATE', targetType: 'COURSE', targetId: r.id, result: 1, detail: name });
  return { data: { id: r.id }, message: '课程已创建' };
});

route('PUT', '/api/admin/courses/:id', academicOnly, async (ctx) => {
  const id = Number(ctx.params.id);
  const course = findById('t_course', id);
  if (!course) throw new AppError(CODES.BAD_REQUEST, '课程不存在');
  const { name, categoryId, credit, dept, description, status } = ctx.body || {};

  course.name = name || course.name;
  course.category_id = Number(categoryId || course.category_id);
  course.credit = credit === undefined ? course.credit : Number(credit);
  course.dept = dept === undefined ? course.dept : dept;
  course.description = description === undefined ? course.description : description;
  course.status = status === undefined ? course.status : Number(status);
  course.updated_at = now();

  logAudit(ctx, { action: 'COURSE_UPDATE', targetType: 'COURSE', targetId: id, result: 1, detail: name || course.name });
  return { data: { id }, message: '课程已更新' };
});

route('DELETE', '/api/admin/courses/:id', academicOnly, async (ctx) => {
  const id = Number(ctx.params.id);
  const used = tbl('t_course_offering').filter((o) => Number(o.course_id) === id);
  if (used.length) throw new AppError(CODES.BAD_REQUEST, '该课程已有开课记录，不能删除，可改为停用');
  removeWhere('t_course_prereq', { course_id: id });
  removeBy('t_course_prereq', (p) => Number(p.prereq_course_id) === id);
  removeWhere('t_course', { id });
  logAudit(ctx, { action: 'COURSE_DELETE', targetType: 'COURSE', targetId: id, result: 1 });
  return { data: { id }, message: '课程已删除' };
});

route('GET', '/api/admin/courses/:id/prereq', academicOnly, async (ctx) => {
  const list = tbl('t_course_prereq')
    .filter((p) => Number(p.course_id) === Number(ctx.params.id))
    .sort((a, b) => Number(a.require_type) - Number(b.require_type) || Number(a.group_no) - Number(b.group_no))
    .map((p) => {
      const c = findById('t_course', p.prereq_course_id);
      return { ...p, prereq_name: c ? c.name : '', course_code: c ? c.course_code : '' };
    });
  return { data: { list } };
});

route('POST', '/api/admin/courses/:id/prereq', academicOnly, async (ctx) => {
  const courseId = Number(ctx.params.id);
  const list = Array.isArray(ctx.body && ctx.body.prereq) ? ctx.body.prereq : [];
  removeWhere('t_course_prereq', { course_id: courseId });
  list.forEach((p) => {
    insert('t_course_prereq', {
      course_id: courseId,
      prereq_course_id: Number(p.prereqCourseId),
      require_type: Number(p.requireType || 1),
      group_no: Number(p.groupNo || 1),
    });
  });
  logAudit(ctx, {
    action: 'PREREQ_UPDATE',
    targetType: 'COURSE',
    targetId: courseId,
    result: 1,
    detail: `先修关系 ${list.length} 条`,
  });
  return { data: { courseId, count: list.length }, message: '先修关系已保存' };
});

/* --- 开课计划与名额 --- */

route('GET', '/api/admin/offerings', academicOnly, async (ctx) => {
  const term = getCurrentTerm();
  const termId = Number(ctx.query.termId) || term.id;

  const rows = tbl('t_course_offering')
    .filter((o) => Number(o.term_id) === Number(termId))
    .map((o) => {
      const c = findById('t_course', o.course_id);
      const cat = findById('t_course_category', c.category_id);
      const t = findById('t_teacher', o.teacher_id);
      const tu = t ? findById('t_user', t.user_id) : null;
      return {
        offering_id: Number(o.id),
        capacity: Number(o.capacity),
        enrolled: Number(o.enrolled),
        status: Number(o.status),
        campus: o.campus,
        remark: o.remark,
        course_code: c.course_code,
        course_name: c.name,
        credit: Number(c.credit),
        course_id: Number(c.id),
        category_name: cat ? cat.name : '',
        teacher_id: t ? Number(t.id) : null,
        teacher_name: tu ? tu.real_name : '',
      };
    })
    .sort((a, b) => String(a.course_code).localeCompare(String(b.course_code)));

  attachSchedules(rows);

  const waitMap = new Map();
  tbl('t_waitlist')
    .filter((w) => Number(w.status) === 1)
    .forEach((w) => {
      const k = Number(w.offering_id);
      waitMap.set(k, (waitMap.get(k) || 0) + 1);
    });
  const enrollMap = new Map();
  tbl('t_enrollment')
    .filter((e) => Number(e.status) === 1)
    .forEach((e) => {
      const k = Number(e.offering_id);
      enrollMap.set(k, (enrollMap.get(k) || 0) + 1);
    });

  const teachers = tbl('t_teacher')
    .map((t) => {
      const u = findById('t_user', t.user_id);
      return {
        id: Number(t.id),
        teacher_no: t.teacher_no,
        real_name: u ? u.real_name : '',
        college: t.college,
        title: t.title,
      };
    })
    .sort((a, b) => String(a.teacher_no).localeCompare(String(b.teacher_no)));

  const courses = tbl('t_course')
    .filter((c) => Number(c.status) === 1)
    .map((c) => ({
      id: Number(c.id),
      course_code: c.course_code,
      name: c.name,
      credit: Number(c.credit),
      category_id: Number(c.category_id),
    }))
    .sort((a, b) => String(a.course_code).localeCompare(String(b.course_code)));

  return {
    data: {
      term,
      list: rows.map((r) => ({
        ...r,
        credit: Number(r.credit),
        remaining: Math.max(0, r.capacity - r.enrolled),
        heat: heatOf(r.enrolled, r.capacity),
        waitlistCount: waitMap.get(r.offering_id) || 0,
        enrolledCount: enrollMap.get(r.offering_id) || 0,
      })),
      teachers,
      courses,
    },
  };
});

route('POST', '/api/admin/offerings', academicOnly, async (ctx) => {
  const { courseId, termId, teacherId, capacity, campus, remark, schedules } = ctx.body || {};
  if (!courseId || !teacherId || !capacity) throw new AppError(CODES.BAD_REQUEST, '课程、教师与容量为必填项');
  const term = getCurrentTerm();
  const tid = Number(termId) || term.id;

  const dup = tbl('t_course_offering').find(
    (o) => Number(o.course_id) === Number(courseId) && Number(o.term_id) === tid && Number(o.teacher_id) === Number(teacherId)
  );
  if (dup) throw new AppError(CODES.BAD_REQUEST, '该课程在本学期已由该教师开课，不能重复开课');
  assertValidSchedules(schedules);

  const r = insert('t_course_offering', {
    course_id: Number(courseId),
    term_id: tid,
    teacher_id: Number(teacherId),
    capacity: Number(capacity),
    enrolled: 0,
    status: 1,
    campus: campus || null,
    remark: remark || null,
  });
  (Array.isArray(schedules) ? schedules : []).forEach((s) => {
    insert('t_course_schedule', {
      offering_id: r.id,
      weekday: Number(s.weekday),
      start_period: Number(s.startPeriod),
      end_period: Number(s.endPeriod),
      parity: Number(s.parity || 0),
      campus: s.campus || campus || null,
      building: s.building || null,
      room: s.room || null,
    });
  });

  logAudit(ctx, {
    action: 'OFFERING_CREATE',
    targetType: 'OFFERING',
    targetId: r.id,
    result: 1,
    detail: `容量 ${capacity}`,
  });
  return { data: { offeringId: r.id }, message: '开课已创建' };
});

route('PUT', '/api/admin/offerings/:id', academicOnly, async (ctx) => {
  const id = Number(ctx.params.id);
  const offering = findById('t_course_offering', id);
  if (!offering) throw new AppError(CODES.OFFERING_NOT_FOUND);

  const { capacity, status, campus, remark, schedules } = ctx.body || {};
  if (capacity !== undefined && Number(capacity) < Number(offering.enrolled)) {
    throw new AppError(CODES.BAD_REQUEST, `容量不能小于已选人数 ${offering.enrolled}`);
  }
  assertValidSchedules(schedules);

  offering.capacity = capacity === undefined ? offering.capacity : Number(capacity);
  offering.status = status === undefined ? offering.status : Number(status);
  offering.campus = campus === undefined ? offering.campus : campus;
  offering.remark = remark === undefined ? offering.remark : remark;
  offering.updated_at = now();

  if (Number(offering.status) === 1 && Number(offering.enrolled) >= Number(offering.capacity)) offering.status = 2;
  else if (Number(offering.status) === 2 && Number(offering.enrolled) < Number(offering.capacity)) offering.status = 1;

  if (Array.isArray(schedules)) {
    removeWhere('t_course_schedule', { offering_id: id });
    schedules.forEach((s) => {
      insert('t_course_schedule', {
        offering_id: id,
        weekday: Number(s.weekday),
        start_period: Number(s.startPeriod),
        end_period: Number(s.endPeriod),
        parity: Number(s.parity || 0),
        campus: s.campus || null,
        building: s.building || null,
        room: s.room || null,
      });
    });
  }

  const isCapacityChange = capacity !== undefined && Number(capacity) !== Number(offering.capacity);
  logAudit(ctx, {
    action: isCapacityChange ? 'CAPACITY_ADJUST' : 'OFFERING_UPDATE',
    targetType: 'OFFERING',
    targetId: id,
    result: 1,
    detail: isCapacityChange ? `容量调整至 ${offering.capacity}（已选 ${offering.enrolled}）` : '更新开课信息',
  });

  let promoteResult = null;
  if (capacity !== undefined && Number(capacity) > Number(offering.enrolled)) {
    const r = promoteFromOffering(id);
    promoteResult = r.result;
  }
  return { data: { id, promoted: promoteResult }, message: '开课已更新' };
});

route('GET', '/api/admin/statistics', academicOnly, async () => {
  const term = getCurrentTerm();
  const waitMap = new Map();
  tbl('t_waitlist')
    .filter((w) => Number(w.status) === 1)
    .forEach((w) => {
      const k = Number(w.offering_id);
      waitMap.set(k, (waitMap.get(k) || 0) + 1);
    });

  const list = tbl('t_course_offering')
    .filter((o) => Number(o.term_id) === Number(term.id))
    .map((o) => {
      const c = findById('t_course', o.course_id);
      const t = findById('t_teacher', o.teacher_id);
      const tu = t ? findById('t_user', t.user_id) : null;
      return {
        offering_id: Number(o.id),
        course_code: c ? c.course_code : '',
        course_name: c ? c.name : '',
        teacher_name: tu ? tu.real_name : '',
        capacity: Number(o.capacity),
        enrolled: Number(o.enrolled),
        status: Number(o.status),
        rate: Number(o.capacity) ? Math.round((Number(o.enrolled) / Number(o.capacity)) * 1000) / 10 : 0,
        waitlist_count: waitMap.get(Number(o.id)) || 0,
      };
    })
    .sort((a, b) => b.rate - a.rate || b.enrolled - a.enrolled);

  return { data: { term, list } };
});

/* --- 批次与学分规则 --- */

route('GET', '/api/admin/batches', academicOnly, async () => {
  const term = getCurrentTerm();
  const nowDate = new Date();
  const list = tbl('t_enroll_batch')
    .filter((b) => Number(b.term_id) === Number(term.id))
    .sort((a, b) => Number(a.priority) - Number(b.priority))
    .map((b) => ({
      ...b,
      type: Number(b.type),
      priority: Number(b.priority),
      status: Number(b.status),
      typeText: Number(b.type) === 2 ? '补退选' : '正常选课',
      state: nowDate < toDate(b.start_time) ? '未开始' : nowDate > toDate(b.end_time) ? '已结束' : '进行中',
    }));
  return { data: { term, list } };
});

route('POST', '/api/admin/batches', academicOnly, async (ctx) => {
  const { name, type, startTime, endTime, targetGrade, targetCollege, priority } = ctx.body || {};
  if (!name || !startTime || !endTime) throw new AppError(CODES.BAD_REQUEST, '批次名称与起止时间为必填项');
  const term = getCurrentTerm();
  const r = insert('t_enroll_batch', {
    term_id: Number(term.id),
    name,
    type: Number(type || 1),
    start_time: String(startTime).replace('T', ' '),
    end_time: String(endTime).replace('T', ' '),
    target_grade: targetGrade || null,
    target_college: targetCollege || null,
    priority: Number(priority || 0),
    status: 1,
  });
  logAudit(ctx, { action: 'BATCH_CREATE', targetType: 'BATCH', targetId: r.id, result: 1, detail: name });
  return { data: { id: r.id }, message: '批次已创建' };
});

route('PUT', '/api/admin/batches/:id', academicOnly, async (ctx) => {
  const id = Number(ctx.params.id);
  const b = findById('t_enroll_batch', id);
  if (!b) throw new AppError(CODES.BAD_REQUEST, '批次不存在');
  const { name, type, startTime, endTime, targetGrade, targetCollege, priority, status } = ctx.body || {};
  b.name = name || b.name;
  b.type = type === undefined ? b.type : Number(type);
  b.start_time = String(startTime || b.start_time).replace('T', ' ');
  b.end_time = String(endTime || b.end_time).replace('T', ' ');
  b.target_grade = targetGrade === undefined ? b.target_grade : targetGrade;
  b.target_college = targetCollege === undefined ? b.target_college : targetCollege;
  b.priority = priority === undefined ? b.priority : Number(priority);
  b.status = status === undefined ? b.status : Number(status);
  b.updated_at = now();
  logAudit(ctx, { action: 'BATCH_UPDATE', targetType: 'BATCH', targetId: id, result: 1, detail: name || b.name });
  return { data: { id }, message: '批次已更新' };
});

route('DELETE', '/api/admin/batches/:id', academicOnly, async (ctx) => {
  const id = Number(ctx.params.id);
  removeWhere('t_enroll_batch', { id });
  logAudit(ctx, { action: 'BATCH_DELETE', targetType: 'BATCH', targetId: id, result: 1 });
  return { data: { id }, message: '批次已删除' };
});

route('GET', '/api/admin/credit-rules', academicOnly, async () => {
  const term = getCurrentTerm();
  const gradeRules = tbl('t_credit_rule')
    .filter((g) => Number(g.term_id) === Number(term.id))
    .sort((a, b) => String(a.grade).localeCompare(String(b.grade)))
    .map((g) => ({ ...g, min_credit: Number(g.min_credit), max_credit: Number(g.max_credit) }));

  const categoryRules = getCategoryCreditRules(term.id).map((c) => ({
    ...c,
    min_credit: c.min_credit === null || c.min_credit === undefined ? null : Number(c.min_credit),
    max_credit: c.max_credit === null || c.max_credit === undefined ? null : Number(c.max_credit),
  }));

  const categories = tbl('t_course_category').sort((a, b) => Number(a.id) - Number(b.id));
  return { data: { term, gradeRules, categoryRules, categories } };
});

route('POST', '/api/admin/credit-rules', academicOnly, async (ctx) => {
  const term = getCurrentTerm();
  const { grade, minCredit, maxCredit } = ctx.body || {};
  if (!grade || maxCredit === undefined) throw new AppError(CODES.BAD_REQUEST, '年级与学分上限为必填项');

  const exist = tbl('t_credit_rule').find(
    (r) => Number(r.term_id) === Number(term.id) && String(r.grade) === String(grade)
  );
  if (exist) {
    exist.min_credit = Number(minCredit || 0);
    exist.max_credit = Number(maxCredit);
    exist.updated_at = now();
  } else {
    insert('t_credit_rule', {
      term_id: Number(term.id),
      grade: String(grade),
      min_credit: Number(minCredit || 0),
      max_credit: Number(maxCredit),
    });
  }
  logAudit(ctx, {
    action: 'CREDIT_RULE_UPDATE',
    targetType: 'TERM',
    targetId: term.id,
    result: 1,
    detail: `${grade} 级上限 ${maxCredit}`,
  });
  return { data: { grade }, message: '学分规则已保存' };
});

route('POST', '/api/admin/category-credit-rules', academicOnly, async (ctx) => {
  const term = getCurrentTerm();
  const { categoryId, minCredit, maxCredit } = ctx.body || {};
  if (!categoryId) throw new AppError(CODES.BAD_REQUEST, '课程类别为必填项');
  const num = (v) => (v === undefined || v === '' || v === null ? null : Number(v));

  const exist = tbl('t_category_credit_rule').find(
    (r) => Number(r.term_id) === Number(term.id) && Number(r.category_id) === Number(categoryId)
  );
  if (exist) {
    exist.min_credit = num(minCredit);
    exist.max_credit = num(maxCredit);
    exist.updated_at = now();
  } else {
    insert('t_category_credit_rule', {
      term_id: Number(term.id),
      category_id: Number(categoryId),
      min_credit: num(minCredit),
      max_credit: num(maxCredit),
    });
  }
  logAudit(ctx, {
    action: 'CATEGORY_CREDIT_RULE_UPDATE',
    targetType: 'TERM',
    targetId: term.id,
    result: 1,
  });
  return { data: { categoryId: Number(categoryId) }, message: '类别学分要求已保存' };
});

/* --- 公告 --- */

route('GET', '/api/admin/announcements', academicOnly, async () => {
  const list = [...tbl('t_announcement')]
    .sort((a, b) => String(b.publish_time).localeCompare(String(a.publish_time)))
    .slice(0, 50)
    .map((a) => {
      const u = findById('t_user', a.publisher_id);
      return { ...a, status: Number(a.status), publisher_name: u ? u.real_name : '' };
    });
  return { data: { list } };
});

route('POST', '/api/admin/announcements', academicOnly, async (ctx) => {
  const { title, content, targetScope, targetGrade, publish } = ctx.body || {};
  if (!title || !content) throw new AppError(CODES.BAD_REQUEST, '公告标题与正文为必填项');
  const status = publish === false ? 0 : 1;

  const r = insert('t_announcement', {
    publisher_id: Number(ctx.user.userId),
    title,
    content,
    target_scope: targetScope || null,
    publish_time: now(),
    status,
  });

  if (status === 1) {
    let targets = tbl('t_user').filter((u) => Number(u.role) === 1);
    if (targetGrade) {
      const ids = tbl('t_student')
        .filter((s) => String(s.grade) === String(targetGrade))
        .map((s) => Number(s.user_id));
      targets = targets.filter((u) => ids.includes(Number(u.id)));
    }
    targets.forEach((u) => {
      sendNotice(u.id, NOTICE_TYPE.ANNOUNCEMENT, `新公告：${title}`, String(content).slice(0, 200), r.id);
    });
  }

  logAudit(ctx, {
    action: 'ANNOUNCEMENT_PUBLISH',
    targetType: 'ANNOUNCEMENT',
    targetId: r.id,
    result: 1,
    detail: title,
  });
  return { data: { id: r.id }, message: status === 1 ? '公告已发布并投递通知' : '公告已保存为草稿' };
});

route('PUT', '/api/admin/announcements/:id/status', academicOnly, async (ctx) => {
  const id = Number(ctx.params.id);
  const status = Number((ctx.body || {}).status);
  const a = findById('t_announcement', id);
  if (a) {
    a.status = status;
    a.updated_at = now();
  }
  logAudit(ctx, {
    action: 'ANNOUNCEMENT_STATUS',
    targetType: 'ANNOUNCEMENT',
    targetId: id,
    result: 1,
    detail: `状态 ${status}`,
  });
  return { data: { id, status }, message: '公告状态已更新' };
});

/* ---------------------------- 系统管理端 ---------------------------- */
/* 注意：/api/admin/users 需先于教务端的路径匹配（与后端挂载顺序一致） */

const sysOnly = [ROLE.SYS_ADMIN];

route('GET', '/api/admin/users', sysOnly, async (ctx) => {
  const pageNo = Number(ctx.query.page) || 1;
  const size = Math.min(Number(ctx.query.size) || 20, 100);

  let rows = tbl('t_user').filter((u) => {
    if (ctx.query.keyword) {
      const kw = String(ctx.query.keyword).toLowerCase();
      if (!String(u.username).toLowerCase().includes(kw) && !String(u.real_name).toLowerCase().includes(kw)) return false;
    }
    if (ctx.query.role && Number(u.role) !== Number(ctx.query.role)) return false;
    if (ctx.query.status !== undefined && ctx.query.status !== '' && Number(u.status) !== Number(ctx.query.status)) return false;
    return true;
  });

  const total = rows.length;
  const sorted = [...rows].sort(
    (a, b) => Number(a.role) - Number(b.role) || String(a.username).localeCompare(String(b.username))
  );

  const list = sorted.slice((pageNo - 1) * size, (pageNo - 1) * size + size).map((u) => {
    const s = tbl('t_student').find((x) => Number(x.user_id) === Number(u.id));
    const t = tbl('t_teacher').find((x) => Number(x.user_id) === Number(u.id));
    return {
      id: Number(u.id),
      username: u.username,
      real_name: u.real_name,
      role: Number(u.role),
      status: Number(u.status),
      last_login_at: u.last_login_at,
      created_at: u.created_at,
      student_no: s ? s.student_no : null,
      grade: s ? s.grade : null,
      college: s ? s.college : null,
      major: s ? s.major : null,
      teacher_no: t ? t.teacher_no : null,
      teacher_college: t ? t.college : null,
      title: t ? t.title : null,
      roleText: ROLE_TEXT[Number(u.role)] || '未知',
    };
  });

  return { data: page(list, total, pageNo, size) };
});

route('POST', '/api/admin/users', sysOnly, async (ctx) => {
  const { username, password, realName, role, studentNo, grade, college, major, teacherNo, title } = ctx.body || {};
  if (!username || !password || !realName || !role) {
    throw new AppError(CODES.BAD_REQUEST, '账号、密码、姓名与角色为必填项');
  }
  if (tbl('t_user').some((u) => u.username === username)) {
    throw new AppError(CODES.BAD_REQUEST, `账号 ${username} 已存在`);
  }

  const u = insert('t_user', {
    username,
    real_name: realName,
    role: Number(role),
    status: 1,
    last_login_at: null,
  });

  if (Number(role) === ROLE.STUDENT) {
    insert('t_student', {
      user_id: u.id,
      student_no: studentNo || username,
      grade: grade || '',
      college: college || '',
      major: major || null,
    });
  } else if (Number(role) === ROLE.TEACHER) {
    insert('t_teacher', {
      user_id: u.id,
      teacher_no: teacherNo || username,
      college: college || '',
      title: title || null,
    });
  }

  logAudit(ctx, {
    action: 'USER_CREATE',
    targetType: 'USER',
    targetId: u.id,
    result: 1,
    detail: `${username} / ${ROLE_TEXT[Number(role)]}`,
  });
  return { data: { userId: u.id }, message: '用户已创建' };
});

route('PUT', '/api/admin/users/:id', sysOnly, async (ctx) => {
  const id = Number(ctx.params.id);
  const user = findById('t_user', id);
  if (!user) throw new AppError(CODES.BAD_REQUEST, '用户不存在');

  const { role, status, realName, newPassword } = ctx.body || {};
  if (Number(id) === Number(ctx.user.userId) && status !== undefined && Number(status) === 0) {
    throw new AppError(CODES.BAD_REQUEST, '不能禁用当前登录的管理员账号');
  }

  const oldRole = Number(user.role);
  const oldStatus = Number(user.status);
  user.role = role === undefined ? user.role : Number(role);
  user.status = status === undefined ? user.status : Number(status);
  user.real_name = realName || user.real_name;
  user.updated_at = now();

  logAudit(ctx, {
    action: 'USER_UPDATE',
    targetType: 'USER',
    targetId: id,
    result: 1,
    detail: `角色 ${oldRole} → ${user.role}；状态 ${oldStatus} → ${user.status}${newPassword ? '；已重置密码' : ''}`,
  });
  return { data: { id }, message: '用户已更新' };
});

route('GET', '/api/admin/audit-logs', sysOnly, async (ctx) => {
  const pageNo = Number(ctx.query.page) || 1;
  const size = Math.min(Number(ctx.query.size) || 20, 200);

  let rows = tbl('t_audit_log').filter((a) => {
    if (ctx.query.action && String(a.action) !== String(ctx.query.action)) return false;
    if (ctx.query.username && !String(a.username || '').toLowerCase().includes(String(ctx.query.username).toLowerCase())) return false;
    if (ctx.query.result !== undefined && ctx.query.result !== '' && Number(a.result) !== Number(ctx.query.result)) return false;
    if (ctx.query.start && String(a.created_at) < String(ctx.query.start).replace('T', ' ')) return false;
    if (ctx.query.end && String(a.created_at) > String(ctx.query.end).replace('T', ' ')) return false;
    return true;
  });

  const total = rows.length;
  const list = [...rows]
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice((pageNo - 1) * size, (pageNo - 1) * size + size)
    .map((a) => ({ ...a, result: Number(a.result) }));

  const actions = [...new Set(tbl('t_audit_log').map((a) => a.action))].sort();
  return { data: { ...page(list, total, pageNo, size), actions } };
});

route('GET', '/api/admin/monitor', sysOnly, async () => {
  const snap = metricsSnapshot(0);
  const waiting = tbl('t_waitlist').filter((w) => Number(w.status) === 1).length;
  const activeEnroll = tbl('t_enrollment').filter((e) => Number(e.status) === 1).length;

  return {
    data: {
      ...snap,
      onlineUsers: sessions.size,
      waitlistTotal: waiting,
      activeEnrollment: activeEnroll,
      rateLimitConfig: CONFIG.rateLimit,
      thresholds: [
        {
          name: '接口错误率',
          value: Math.round((100 - snap.successRate) * 100) / 100,
          unit: '%',
          threshold: '1%',
          level: 100 - snap.successRate > 1 ? 'warn' : 'ok',
        },
        { name: '选课写接口 P95', value: snap.writeP95Ms, unit: 'ms', threshold: '2000ms', level: snap.writeP95Ms > 2000 ? 'warn' : 'ok' },
        { name: '排队队列长度', value: snap.queueLength, unit: '人', threshold: '200 人', level: snap.queueLength > 200 ? 'warn' : 'ok' },
        { name: '缓存与库余量差值', value: snap.cacheDiff, unit: '', threshold: '持续 > 0', level: snap.cacheDiff > 0 ? 'warn' : 'ok' },
      ],
    },
  };
});

/* ================================================================== */
/* 请求分发                                                            */
/* ================================================================== */

function checkRateLimit(userId) {
  const bucket = rateBuckets.get(userId) || [];
  const cutoff = Date.now() - CONFIG.rateLimit.windowSeconds * 1000;
  const hits = bucket.filter((t) => t > cutoff);
  hits.push(Date.now());
  rateBuckets.set(userId, hits);
  if (hits.length > CONFIG.rateLimit.hardLimit) {
    return { needCaptcha: true, count: hits.length };
  }
  if (hits.length > CONFIG.rateLimit.softLimit) {
    return { limited: true, count: hits.length, retryAfter: CONFIG.rateLimit.windowSeconds };
  }
  return { count: hits.length };
}

/**
 * 主入口：处理一次「请求」，返回后端同构的响应体 { code, message, data }。
 * 前端 api.js 只关心这个结构，因此页面代码与数据库版完全共用。
 */
async function handle(method, path, query, body, token) {
  const started = Date.now();
  const cleanPath = String(path).split('?')[0];

  let result;
  try {
    result = await dispatch(method, cleanPath, query || {}, body, token);
  } catch (err) {
    if (err instanceof AppError) {
      result = { code: err.code, message: err.message, data: err.extra === undefined ? null : err.extra };
    } else {
      result = { code: CODES.INTERNAL_ERROR, message: MESSAGES[CODES.INTERNAL_ERROR], data: { detail: String(err && err.message ? err.message : err) } };
    }
  }

  recordMetric(method + ' ' + cleanPath, result.code, Date.now() - started);
  return result;
}

async function dispatch(method, path, query, body, token) {
  let matched = null;
  let params = null;

  for (let i = 0; i < ROUTES.length; i += 1) {
    const r = ROUTES[i];
    if (r.method !== method) continue;
    const p = matchPath(r.path, path);
    if (p) {
      matched = r;
      params = p;
      break;
    }
  }

  if (!matched) {
    return { code: CODES.BAD_REQUEST, message: `接口不存在：${method} ${path}`, data: null };
  }

  // 鉴权
  let user = null;
  if (matched.roles !== null) {
    const session = token ? sessions.get(token) : null;
    if (!session) return { code: CODES.UNAUTHORIZED, message: MESSAGES[CODES.UNAUTHORIZED], data: null };
    if (isSessionIdle(token)) {
      sessions.delete(token);
      return { code: CODES.UNAUTHORIZED, message: MESSAGES[CODES.UNAUTHORIZED], data: null };
    }
    touchSession(token);
    if (matched.roles !== 'any' && !matched.roles.includes(Number(session.role))) {
      logAudit({ user: { userId: session.userId, username: session.username }, ip: '127.0.0.1' }, {
        action: 'FORBIDDEN_ACCESS',
        targetType: 'API',
        result: 0,
        detail: `角色 ${session.role} 访问受限接口 ${method} ${path}`,
      });
      return { code: CODES.FORBIDDEN, message: MESSAGES[CODES.FORBIDDEN], data: null };
    }
    user = {
      userId: session.userId,
      username: session.username,
      realName: session.realName,
      role: Number(session.role),
      jti: token,
    };
  }

  const ctx = { params, query, body: body || {}, user, ip: '127.0.0.1' };

  if (user && matched.roles && matched.roles.includes(ROLE.STUDENT) && matched.roles.length === 1) {
    ctx.student = requireStudent(user);
  }

  // 幂等去重
  const requestId = (body && body.requestId) || query.requestId || null;
  if (matched.opts.idempotent && requestId && user) {
    const key = `${user.userId}:${requestId}`;
    const cached = idempotencyCache.get(key);
    if (cached && Date.now() - cached.at < CONFIG.idempotencyTtlMinutes * 60 * 1000) {
      return cached.body;
    }
  }

  // 限速
  if (matched.opts.rateLimited && user) {
    const state = checkRateLimit(user.userId);
    if (state.needCaptcha) {
      return {
        code: CODES.RATE_LIMITED,
        message: '操作过于频繁，请完成安全验证后重试',
        data: { needCaptcha: true, count: state.count },
      };
    }
    if (state.limited) {
      return {
        code: CODES.RATE_LIMITED,
        message: `操作过于频繁，请 ${state.retryAfter} 秒后再试`,
        data: { retryAfter: state.retryAfter, count: state.count },
      };
    }
  }

  const out = await matched.handler(ctx);
  if (!out) return { code: CODES.OK, message: '操作成功', data: null };

  // handler 允许直接返回完整响应体（用于需要自定义错误码的场景，如登录验证码）
  const response =
    out.code !== undefined && out.message !== undefined && out.data !== undefined && typeof out.code === 'number'
      ? out
      : { code: CODES.OK, message: out.message || '操作成功', data: out.data === undefined ? null : out.data };

  if (matched.opts.idempotent && requestId && user && response.code === 0) {
    idempotencyCache.set(`${user.userId}:${requestId}`, { body: response, at: Date.now() });
  }
  return response;
}

module.exports = { handle, ROUTES, dispatch, ROLE, DEMO_SECRET };
