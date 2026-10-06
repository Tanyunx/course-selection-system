'use strict';

/**
 * 学生上下文中间件：把 t_student 记录挂到 req.student，供选课、课表等接口使用。
 */

const account = require('../services/accountService');
const { CODES, AppError } = require('../utils/errors');
const { fail } = require('../utils/response');

async function loadStudent(req, res, next) {
  try {
    const student = await account.getStudentByUserId(req.user.userId);
    if (!student) throw new AppError(CODES.FORBIDDEN, '未找到学生档案，请联系教务管理员');
    req.student = student;
    return next();
  } catch (err) {
    if (err instanceof AppError) return fail(res, err.code, err.message);
    return next(err);
  }
}

async function loadTeacher(req, res, next) {
  try {
    const teacher = await account.getTeacherByUserId(req.user.userId);
    if (!teacher) throw new AppError(CODES.FORBIDDEN, '未找到教师档案，请联系教务管理员');
    req.teacher = teacher;
    return next();
  } catch (err) {
    if (err instanceof AppError) return fail(res, err.code, err.message);
    return next(err);
  }
}

module.exports = { loadStudent, loadTeacher };
