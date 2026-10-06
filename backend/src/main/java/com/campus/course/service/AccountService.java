package com.campus.course.service;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.campus.course.db.Db;

/**
 * 账号与学生/教师身份服务（等价于原 Node 版的 services/accountService.js）。
 *
 * <p>t_user 与 t_student / t_teacher 是一对一扩展关系，按角色决定用哪张扩展表。
 */
@Service
public class AccountService {

    private final Db db;

    public AccountService(Db db) {
        this.db = db;
    }

    /** 按主键取用户（不含口令哈希）。 */
    public Map<String, Object> getUserById(long userId) {
        return db.queryOne(
                "SELECT id, username, real_name, role, status, last_login_at FROM t_user WHERE id = ?",
                userId);
    }

    /** 按登录账号取用户（含口令哈希，仅供登录校验使用）。 */
    public Map<String, Object> getUserByUsername(String username) {
        return db.queryOne("SELECT * FROM t_user WHERE username = ?", username);
    }

    public Map<String, Object> getStudentByUserId(long userId) {
        return db.queryOne("SELECT * FROM t_student WHERE user_id = ?", userId);
    }

    public Map<String, Object> getStudentById(long studentId) {
        return db.queryOne("""
                SELECT s.*, u.real_name, u.username, u.status AS user_status
                  FROM t_student s JOIN t_user u ON u.id = s.user_id
                 WHERE s.id = ?
                """, studentId);
    }

    public Map<String, Object> getTeacherByUserId(long userId) {
        return db.queryOne("SELECT * FROM t_teacher WHERE user_id = ?", userId);
    }

    /**
     * 构造登录后的用户信息体（profile）。
     * 学生补 studentId / studentNo / grade / college / major，教师补 teacherId / teacherNo / college / title。
     */
    public Map<String, Object> buildProfile(Map<String, Object> user) {
        Map<String, Object> base = new LinkedHashMap<>();
        base.put("userId", Db.num(user, "id"));
        base.put("username", user.get("username"));
        base.put("realName", user.get("real_name"));
        base.put("role", Db.num(user, "role"));

        long role = Db.num(user, "role");
        if (role == 1) {
            Map<String, Object> s = getStudentByUserId(Db.num(user, "id"));
            if (s != null) {
                base.put("studentId", Db.num(s, "id"));
                base.put("studentNo", s.get("student_no"));
                base.put("grade", s.get("grade"));
                base.put("college", s.get("college"));
                base.put("major", s.get("major"));
            }
        } else if (role == 2) {
            Map<String, Object> t = getTeacherByUserId(Db.num(user, "id"));
            if (t != null) {
                base.put("teacherId", Db.num(t, "id"));
                base.put("teacherNo", t.get("teacher_no"));
                base.put("college", t.get("college"));
                base.put("title", t.get("title"));
            }
        }
        return base;
    }
}
