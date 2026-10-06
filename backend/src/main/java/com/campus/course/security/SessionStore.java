package com.campus.course.security;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import com.campus.course.config.AppProperties;

/**
 * 服务端会话存储（内存实现，等价于原 Node 版的 store/sessionStore.js）。
 *
 * <p>设计文档 2.4 / 7.3：登录后签发令牌，令牌 30 分钟空闲超时，退出登录即失效。
 * 之所以在令牌之外再存一份会话，是为了支持"注销立即失效"与"空闲超时"——
 * 纯自包含 JWT 无法做到这两点。
 *
 * <p>单机内存实现；若要横向扩展，把本类替换为 Redis 实现即可，接口不变。
 */
@Component
public class SessionStore {

    /** 会话记录 */
    public record Session(long userId, String username, String realName, int role,
                          long lastActive, long loginAt) {
        Session touch() {
            return new Session(userId, username, realName, role, System.currentTimeMillis(), loginAt);
        }
    }

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final long idleMillis;

    public SessionStore(AppProperties props) {
        this.idleMillis = props.getAuth().getIdleTimeoutMinutes() * 60L * 1000L;
    }

    public void create(TokenService.Payload payload) {
        long now = System.currentTimeMillis();
        sessions.put(payload.jti(), new Session(
                payload.userId(), payload.username(), payload.realName(), payload.role(), now, now));
    }

    public Session get(String jti) {
        return jti == null ? null : sessions.get(jti);
    }

    /** 刷新活跃时间；会话不存在返回 null。 */
    public Session touch(String jti) {
        Session s = sessions.get(jti);
        if (s == null) {
            return null;
        }
        Session updated = s.touch();
        sessions.put(jti, updated);
        return updated;
    }

    public void destroy(String jti) {
        if (jti != null) {
            sessions.remove(jti);
        }
    }

    /** 是否已空闲超时；会话不存在视为已失效。 */
    public boolean isIdle(String jti) {
        Session s = sessions.get(jti);
        if (s == null) {
            return true;
        }
        return System.currentTimeMillis() - s.lastActive() > idleMillis;
    }

    /** 在线人数（用于运行监控页）。 */
    public long onlineCount() {
        long now = System.currentTimeMillis();
        return sessions.values().stream().filter(s -> now - s.lastActive() <= idleMillis).count();
    }

    /** 定期清理过期会话，避免内存泄漏。 */
    public void sweep() {
        long now = System.currentTimeMillis();
        sessions.entrySet().removeIf(e -> now - e.getValue().lastActive() > idleMillis);
    }
}
