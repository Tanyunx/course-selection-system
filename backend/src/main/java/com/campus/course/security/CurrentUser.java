package com.campus.course.security;

/**
 * 当前请求的登录用户（线程级）。
 *
 * <p>由 {@link AuthInterceptor} 在 preHandle 写入、afterCompletion 清理，
 * Controller / Service 通过 {@link #get()} 取用，避免把 userId 层层透传。
 */
public final class CurrentUser {

    /** 登录主体：来自令牌载荷 + 服务端会话记录 */
    public record Principal(long userId, String username, String realName, int role, String jti, String clientIp) {
    }

    private static final ThreadLocal<Principal> HOLDER = new ThreadLocal<>();

    private CurrentUser() {
    }

    public static void set(Principal p) {
        HOLDER.set(p);
    }

    public static Principal get() {
        return HOLDER.get();
    }

    /** 取当前用户；未登录时抛异常（正常情况下拦截器已保证非空） */
    public static Principal require() {
        Principal p = HOLDER.get();
        if (p == null) {
            throw new com.campus.course.common.BizException(com.campus.course.common.ErrorCode.TOKEN_INVALID);
        }
        return p;
    }

    public static long userId() {
        return require().userId();
    }

    public static int role() {
        return require().role();
    }

    public static String clientIp() {
        Principal p = HOLDER.get();
        return p == null ? "" : p.clientIp();
    }

    public static void clear() {
        HOLDER.remove();
    }
}
