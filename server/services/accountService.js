'use strict';

/**
 * 账号与学生/教师身份服务。
 * t_user 与 t_student、t_teacher 为一对一扩展关系，按角色决定使用哪张扩展表。
 */

const db = require('../db');

async function getUserById(userId) {
  return db.queryOne(
    `SELECT id, username, real_name, role, status, last_login_at FROM t_user WHERE id = ?`,
    [userId]
  );
}

async function getUserByUsername(username) {
  return db.queryOne(`SELECT * FROM t_user WHERE username = ?`, [username]);
}

async function getStudentByUserId(userId) {
  return db.queryOne(`SELECT * FROM t_student WHERE user_id = ?`, [userId]);
}

async function getStudentById(studentId) {
  return db.queryOne(
    `SELECT s.*, u.real_name, u.username, u.status AS user_status
       FROM t_student s JOIN t_user u ON u.id = s.user_id
      WHERE s.id = ?`,
    [studentId]
  );
}

async function getTeacherByUserId(userId) {
  return db.queryOne(`SELECT * FROM t_teacher WHERE user_id = ?`, [userId]);
}

/** 构造登录后的用户信息体 */
async function buildProfile(user) {
  const base = {
    userId: user.id,
    username: user.username,
    realName: user.real_name,
    role: user.role,
  };
  if (user.role === 1) {
    const s = await getStudentByUserId(user.id);
    if (s) Object.assign(base, { studentId: s.id, studentNo: s.student_no, grade: s.grade, college: s.college, major: s.major });
  } else if (user.role === 2) {
    const t = await getTeacherByUserId(user.id);
    if (t) Object.assign(base, { teacherId: t.id, teacherNo: t.teacher_no, college: t.college, title: t.title });
  }
  return base;
}

module.exports = {
  getUserById,
  getUserByUsername,
  getStudentByUserId,
  getStudentById,
  getTeacherByUserId,
  buildProfile,
};
