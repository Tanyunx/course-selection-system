package com.campus.course.security;

/**
 * 角色常量（对应设计文档表 26 角色权限矩阵）。
 *
 * <p>1 学生 / 2 教师 / 3 教务管理员 / 4 系统管理员。
 */
public final class Role {

    public static final int STUDENT = 1;
    public static final int TEACHER = 2;
    public static final int ACADEMIC_ADMIN = 3;
    public static final int SYS_ADMIN = 4;

    private Role() {
    }

    public static String name(int role) {
        return switch (role) {
            case STUDENT -> "student";
            case TEACHER -> "teacher";
            case ACADEMIC_ADMIN -> "academic_admin";
            case SYS_ADMIN -> "sys_admin";
            default -> "unknown";
        };
    }

    public static String label(int role) {
        return switch (role) {
            case STUDENT -> "学生";
            case TEACHER -> "教师";
            case ACADEMIC_ADMIN -> "教务管理员";
            case SYS_ADMIN -> "系统管理员";
            default -> "未知角色";
        };
    }
}
