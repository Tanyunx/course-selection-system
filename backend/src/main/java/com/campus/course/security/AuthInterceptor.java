package com.campus.course.security;

import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.service.AuditService;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * 鉴权与 RBAC 拦截器（对应设计文档 2.4、7.3 与表 26 角色权限矩阵）。
 *
 * <p>行为等价于原 Node 版的 middleware/auth.js：
 * <ul>
 *   <li>解析 {@code Authorization: Bearer <token>}（兼容 {@code X-Token}），校验签名；</li>
 *   <li>再查服务端会话，不存在或已空闲超时 → 1002；</li>
 *   <li>命中会话则刷新活跃时间，并把登录主体写入 {@link CurrentUser}；</li>
 *   <li>方法或类上标注了 {@link RequireRole} 而角色不匹配 → 1003，并写一条越权审计日志。</li>
 * </ul>
 *
 * <p>放行路径由 {@code WebConfig} 通过 excludePathPatterns 指定：健康检查、
 * 登录与验证码接口无需登录（与 Node 版逐路由挂鉴权中间件的效果一致）。
 */
@Component
public class AuthInterceptor implements HandlerInterceptor {

    private final TokenService tokens;
    private final SessionStore sessions;
    private final AuditService audit;

    public AuthInterceptor(TokenService tokens, SessionStore sessions, AuditService audit) {
        this.tokens = tokens;
        this.sessions = sessions;
        this.audit = audit;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod method)) {
            return true;
        }

        String raw = readToken(request);
        TokenService.Payload payload = raw == null ? null : tokens.verify(raw);
        if (payload == null || sessions.get(payload.jti()) == null) {
            throw new BizException(ErrorCode.TOKEN_INVALID);
        }
        if (sessions.isIdle(payload.jti())) {
            sessions.destroy(payload.jti());
            throw new BizException(ErrorCode.TOKEN_INVALID);
        }
        SessionStore.Session session = sessions.touch(payload.jti());

        CurrentUser.set(new CurrentUser.Principal(
                session.userId(), session.username(), session.realName(), session.role(),
                payload.jti(), clientIp(request)));

        RequireRole require = method.getMethodAnnotation(RequireRole.class);
        if (require == null) {
            require = method.getBeanType().getAnnotation(RequireRole.class);
        }
        if (require != null && !allows(require.value(), session.role())) {
            // 越权访问留痕，便于运维排查；审计自身失败不影响主流程
            audit.logSafe(request, "FORBIDDEN_ACCESS", "API", null, 0,
                    "角色 " + Role.name(session.role()) + " 访问受限接口 "
                            + request.getMethod() + " " + request.getRequestURI());
            throw new BizException(ErrorCode.NO_PERMISSION);
        }
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        CurrentUser.clear();
    }

    private static boolean allows(int[] roles, int actual) {
        for (int r : roles) {
            if (r == actual) {
                return true;
            }
        }
        return false;
    }

    private static String readToken(HttpServletRequest request) {
        String h = request.getHeader("Authorization");
        if (h != null && h.startsWith("Bearer ")) {
            return h.substring(7).trim();
        }
        String x = request.getHeader("X-Token");
        return x == null ? null : x.trim();
    }

    /** 取真实客户端 IP：优先反代写入的 X-Forwarded-For，与 Node 版一致。 */
    static String clientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) {
            String first = xff.split(",")[0].trim();
            if (!first.isEmpty()) {
                return first;
            }
        }
        String ip = request.getRemoteAddr();
        return ip == null ? "" : ip;
    }
}
