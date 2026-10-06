package com.campus.course.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.campus.course.db.Db;
import com.campus.course.security.CurrentUser;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 审计日志服务（对应设计文档 2.3、7.3，等价于原 Node 版的 services/audit.js）。
 *
 * <p>关键操作写入 t_audit_log，包含操作人、IP、结果与失败原因，日志保留 180 天。
 * 约定：审计写入失败绝不能中断业务，因此对外暴露的 logSafe 会吞掉异常。
 */
@Service
public class AuditService {

    private static final Logger log = LoggerFactory.getLogger(AuditService.class);

    private final Db db;

    public AuditService(Db db) {
        this.db = db;
    }

    /** 记录一条审计；操作人取当前登录会话（未登录则为空）。异常会向上抛。 */
    public void log(String action, String targetType, Long targetId, int result, String detail) {
        CurrentUser.Principal p = CurrentUser.get();
        insert(p == null ? null : p.userId(),
                p == null ? null : p.username(),
                p == null ? "" : p.clientIp(),
                action, targetType, targetId, result, detail);
    }

    /** 记录一条审计，失败只打日志不影响业务。 */
    public void logSafe(HttpServletRequest request, String action, String targetType,
                        Long targetId, int result, String detail) {
        try {
            CurrentUser.Principal p = CurrentUser.get();
            insert(p == null ? null : p.userId(),
                    p == null ? null : p.username(),
                    request == null ? "" : clientIp(request),
                    action, targetType, targetId, result, detail);
        } catch (Exception e) {
            log.warn("审计写入失败 action={} err={}", action, e.getMessage());
        }
    }

    /** 显式指定操作人，用于登录失败等尚无会话的场景。 */
    public void logAs(Long userId, String username, String ip, String action,
                      String targetType, Long targetId, int result, String detail) {
        try {
            insert(userId, username, ip, action, targetType, targetId, result, detail);
        } catch (Exception e) {
            log.warn("审计写入失败 action={} err={}", action, e.getMessage());
        }
    }

    private void insert(Long userId, String username, String ip, String action,
                        String targetType, Long targetId, int result, String detail) {
        db.update("""
                INSERT INTO t_audit_log (user_id, username, action, target_type, target_id, ip, result, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                userId, username, action, targetType, targetId, ip, result,
                detail == null ? null : truncate(detail, 500));
    }

    /** 截断到数据库列长度上限，避免超长文本插入失败 */
    public static String truncate(String s, int max) {
        if (s == null) {
            return null;
        }
        return s.length() <= max ? s : s.substring(0, max);
    }

    /** 取真实客户端 IP：优先反代写入的 X-Forwarded-For */
    public static String clientIp(HttpServletRequest request) {
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
