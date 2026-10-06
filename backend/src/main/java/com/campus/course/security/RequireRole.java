package com.campus.course.security;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 角色校验注解：标注在 Controller 类或方法上，声明允许访问的角色。
 *
 * <p>未标注表示只要登录即可访问；角色不匹配由 {@link AuthInterceptor} 返回 1003 并写审计日志。
 */
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
public @interface RequireRole {

    int[] value();
}
