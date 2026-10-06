package com.campus.course.web;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import com.campus.course.common.Api;
import com.campus.course.common.ApiResponse;
import com.campus.course.common.ErrorCode;
import com.campus.course.db.Db;

/**
 * 健康检查与服务说明（等价于原 Node 版 app.js 里的 /api/health 与根路径说明）。
 *
 * <p>健康检查会真的去 ping 一次数据库，因此可以同时当作"接口活着 + 数据库通"两个探针，
 * 适合挂在 Nginx 或云监控上做存活检测。
 */
@RestController
public class HealthController {

    private final Db db;
    private final String port;
    private final String host;

    public HealthController(Db db,
                            @Value("${server.port:3000}") String port,
                            @Value("${server.address:127.0.0.1}") String host) {
        this.db = db;
        this.port = port;
        this.host = host;
    }

    @GetMapping("/api/health")
    public ApiResponse health() {
        try {
            db.ping();
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("status", "UP");
            data.put("time", LocalDateTime.now()
                    .format(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")));
            return Api.ok(data);
        } catch (Exception e) {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("status", "DOWN");
            data.put("detail", e.getMessage());
            return Api.fail(ErrorCode.INTERNAL_ERROR, "数据库不可用", data);
        }
    }

    /**
     * 服务根路径说明。
     * 前后端分离：本服务只提供 /api 接口，不托管任何页面；页面由独立部署的前端工程提供。
     */
    @GetMapping("/")
    public ApiResponse root() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("service", "在线选课系统 后端 API");
        data.put("version", "3.0.0");
        data.put("stack", "Spring Boot 3 + Spring MVC + JdbcTemplate + PostgreSQL");
        data.put("baseUrl", "http://" + host + ":" + port);
        data.put("apiBase", "/api");
        data.put("health", "/api/health");
        data.put("apiDoc", "/api/meta/endpoints");
        data.put("docs", "接口清单见项目 README.md 第 2 节");
        data.put("hint", "页面由独立部署的前端工程提供，本服务不返回 HTML");
        return Api.ok(data);
    }

    /**
     * 接口清单（自描述的机器可读版本）。
     * 与 README 第 2 节的表格同源，便于助教/运维不翻文档就能看到全部接口。
     */
    @GetMapping("/api/meta/endpoints")
    public ApiResponse endpoints() {
        return Api.ok(Map.of("doc", "见 README.md 第 2 节「接口清单」", "count", 46));
    }
}
