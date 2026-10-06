package com.campus.course.web;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.campus.course.common.Api;
import com.campus.course.common.ApiResponse;
import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.db.Db;
import com.campus.course.security.CurrentUser;

/**
 * 通知中心与公告接口
 * （对应设计文档 2.3、表 4，等价于原 Node 版的 routes/notices.js）。
 */
@RestController
@RequestMapping("/api")
public class NoticeController {

    private static final Map<Integer, String> NOTICE_TYPE_TEXT = Map.of(
            1, "选课结果",
            2, "候补递补",
            3, "递补失败",
            4, "退课",
            5, "公告");

    private final Db db;

    public NoticeController(Db db) {
        this.db = db;
    }

    /** 通知列表，支持按类型与未读筛选 */
    @GetMapping("/notices")
    public ApiResponse list(@RequestParam Map<String, String> q) {
        long userId = CurrentUser.userId();
        int pageNo = Math.max(1, Api.intOf(q.get("page"), 1));
        int size = Math.min(Api.intOf(q.get("size"), 20), 100);

        StringBuilder where = new StringBuilder("user_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(userId);
        if (q.get("type") != null && !q.get("type").isBlank()) {
            where.append(" AND type = ?");
            params.add(Api.intOf(q.get("type"), 0));
        }
        if ("true".equalsIgnoreCase(String.valueOf(q.get("unread")))) {
            where.append(" AND is_read = 0");
        }

        Long total = db.queryScalar(
                "SELECT COUNT(*) AS total FROM t_notice WHERE " + where, Long.class, params.toArray());

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(size);
        pageParams.add((pageNo - 1) * size);
        List<Map<String, Object>> rows = db.query(
                "SELECT * FROM t_notice WHERE " + where
                        + " ORDER BY is_read ASC, created_at DESC LIMIT ? OFFSET ?",
                pageParams.toArray());

        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            Map<String, Object> m = new LinkedHashMap<>(r);
            m.put("typeText", NOTICE_TYPE_TEXT.getOrDefault((int) Db.num(r, "type"), "通知"));
            list.add(m);
        }

        Map<String, Object> unread = db.queryOne(
                "SELECT COUNT(*) AS cnt FROM t_notice WHERE user_id = ? AND is_read = 0", userId);

        Map<String, Object> data = ApiResponse.pageMap(
                list, total == null ? 0 : total, pageNo, size);
        data.put("unread", unread == null ? 0L : Db.num(unread, "cnt"));
        return Api.ok(data);
    }

    /** 标记单条已读 */
    @PostMapping("/notices/{id}/read")
    public ApiResponse read(@PathVariable long id) {
        Map<String, Object> row = db.queryOne(
                "SELECT * FROM t_notice WHERE id = ? AND user_id = ?", id, CurrentUser.userId());
        if (row == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "通知不存在");
        }
        db.update("UPDATE t_notice SET is_read = 1 WHERE id = ?", id);
        return Api.ok(Map.of("id", id, "isRead", true));
    }

    /** 全部标记已读 */
    @PostMapping("/notices/read-all")
    public ApiResponse readAll() {
        db.update("UPDATE t_notice SET is_read = 1 WHERE user_id = ? AND is_read = 0",
                CurrentUser.userId());
        return Api.ok(Map.of("done", true));
    }

    /** 公告列表（全体可见） */
    @GetMapping("/announcements")
    public ApiResponse announcements() {
        List<Map<String, Object>> rows = db.query("""
                SELECT a.*, u.real_name AS publisher_name FROM t_announcement a
                  JOIN t_user u ON u.id = a.publisher_id
                 WHERE a.status = 1 ORDER BY a.publish_time DESC LIMIT 20
                """);
        return Api.ok(Map.of("list", rows));
    }
}
