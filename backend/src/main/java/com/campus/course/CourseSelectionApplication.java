package com.campus.course;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 在线选课系统 · 后端服务启动类。
 *
 * <p>架构：B/S 三层 —— 表现层（web 包，Spring MVC Controller）/
 * 业务逻辑层（service 包）/ 数据访问层（db 包，JdbcTemplate + PostgreSQL）。
 *
 * <p>前后端分离：本服务只提供 {@code /api} 接口（JSON），不返回任何 HTML；
 * 页面由独立部署的前端工程 {@code frontend/} 提供，开发时由 Nginx 或静态服务器托管，
 * 生产环境用 Nginx 把 {@code /api} 反向代理到本服务（见 README 第 5 节）。
 *
 * <p>并发一致性：选课/退课/换课全部走事务 + 条件更新（{@code enrolled < capacity}），
 * 由 PostgreSQL 的行级锁保证余量不为负，详见 {@code EnrollmentService}。
 */
@SpringBootApplication
@EnableScheduling
public class CourseSelectionApplication {

    public static void main(String[] args) {
        SpringApplication.run(CourseSelectionApplication.class, args);
    }
}
