package com.campus.course.config;

import java.util.Arrays;
import java.util.List;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import com.campus.course.common.Api;
import com.campus.course.security.AuthInterceptor;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Web 层配置：跨域与拦截器。
 *
 * <h2>跨域（前后端分离的核心配置）</h2>
 * 前端是独立工程，开发时跑在 http://localhost:5173 之类的地址，生产时由 Nginx 托管，
 * 与后端不是同一个来源，浏览器会发起跨源请求，因此必须显式放行。
 * 白名单通过 {@code CORS_ORIGINS} 配置，默认 {@code *}；本项目用 Bearer 令牌鉴权、
 * 不依赖 Cookie，因此不开启 Allow-Credentials（这一点与原 Node 版一致，
 * 也是"跨域 + 安全证书"要求的落地方式：生产环境建议在前端域名上配 HTTPS，
 * 并把 CORS_ORIGINS 收敛为前端实际域名，而不是继续用 *）。
 *
 * <h2>拦截器</h2>
 * <ul>
 *   <li>{@code apiTimingInterceptor}：记录请求开始时间与归一化路径，供运行监控聚合；</li>
 *   <li>{@link AuthInterceptor}：登录校验与角色校验。</li>
 * </ul>
 * 放行清单与原 Node 版的"逐路由挂鉴权"等价：健康检查、登录、验证码三个接口无需登录。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    /** 无需登录即可访问的接口 */
    private static final List<String> PUBLIC_PATHS = List.of(
            "/api/health",
            "/api/auth/login",
            "/api/auth/captcha");

    private final AppProperties props;
    private final AuthInterceptor authInterceptor;

    public WebConfig(AppProperties props, AuthInterceptor authInterceptor) {
        this.props = props;
        this.authInterceptor = authInterceptor;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        String origins = props.getCors().getAllowedOrigins();
        String[] list = Arrays.stream(origins.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toArray(String[]::new);

        var registration = registry.addMapping("/**")
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("Content-Type", "Authorization", "X-Token")
                .exposedHeaders("X-Idempotent-Replay")
                .maxAge(600)
                .allowCredentials(false);

        if (list.length == 0 || Arrays.asList(list).contains("*")) {
            registration.allowedOriginPatterns("*");
        } else {
            registration.allowedOrigins(list);
        }
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new ApiTimingInterceptor()).addPathPatterns("/api/**");

        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns(PUBLIC_PATHS);
    }

    /**
     * 记录请求开始时间与归一化路径。
     *
     * <p>路径归一化把 {@code /api/courses/12} 收敛成 {@code /api/courses/:id}，
     * 否则监控页的接口热度会被 id 打散成几百条。
     */
    static class ApiTimingInterceptor implements HandlerInterceptor {

        @Override
        public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
            request.setAttribute(Api.START_ATTR, System.currentTimeMillis());
            request.setAttribute(Api.PATH_ATTR, normalize(request.getRequestURI()));
            return true;
        }

        static String normalize(String uri) {
            String[] parts = uri.split("/");
            StringBuilder sb = new StringBuilder();
            for (String p : parts) {
                if (p.isEmpty()) {
                    continue;
                }
                sb.append('/').append(p.matches("\\d+") ? ":id" : p);
            }
            return sb.isEmpty() ? "/" : sb.toString();
        }
    }
}
