package com.campus.course.service;

import org.springframework.stereotype.Service;

import com.campus.course.db.Db;

/**
 * 通知服务（对应设计文档 2.3 通知中心，等价于原 Node 版的 services/notice.js）。
 *
 * <p>线程内直接写库；真实高并发场景下可替换为消息队列异步投递（设计文档 8.3 的可选增强项）。
 * 关键点：递补流程在事务中调用本服务，Spring 的 JdbcTemplate 会自动加入当前事务，
 * 因此通知与选课记录同生共死，不会出现"递补回滚了但通知已发出"。
 */
@Service
public class NoticeService {

    /* 通知类型，与前端 NOTICE_TYPE_TEXT 对应 */
    public static final int TYPE_ENROLL_RESULT = 1;
    public static final int TYPE_WAITLIST_PROMOTED = 2;
    public static final int TYPE_WAITLIST_FAILED = 3;
    public static final int TYPE_DROP_RESULT = 4;
    public static final int TYPE_ANNOUNCEMENT = 5;

    private final Db db;

    public NoticeService(Db db) {
        this.db = db;
    }

    public void send(long userId, int type, String title, String content, Long relatedId) {
        db.update("""
                INSERT INTO t_notice (user_id, type, title, content, related_id, is_read)
                VALUES (?, ?, ?, ?, ?, 0)
                """,
                userId, type,
                AuditService.truncate(title, 100),
                AuditService.truncate(content, 500),
                relatedId);
    }

    public void send(long userId, int type, String title, String content) {
        send(userId, type, title, content, null);
    }
}
