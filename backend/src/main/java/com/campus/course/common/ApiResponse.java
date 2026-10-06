package com.campus.course.common;

import java.util.LinkedHashMap;

/**
 * 统一返回体：{@code {"code":0,"message":"操作成功","data":...}}
 *
 * <p>对应设计文档 2.4 接口设计与表 4。前端 api.js 只认这个结构，
 * 因此业务失败也返回 HTTP 200 + 非 0 的 code（只有资源不存在等路由级错误才用 4xx）。
 */
public class ApiResponse {

    private int code;
    private String message;
    private Object data;

    public ApiResponse() {
    }

    public ApiResponse(int code, String message, Object data) {
        this.code = code;
        this.message = message;
        this.data = data;
    }

    public static ApiResponse ok(Object data) {
        return new ApiResponse(ErrorCode.SUCCESS, "操作成功", data);
    }

    public static ApiResponse ok(Object data, String message) {
        return new ApiResponse(ErrorCode.SUCCESS, message, data);
    }

    public static ApiResponse ok() {
        return new ApiResponse(ErrorCode.SUCCESS, "操作成功", null);
    }

    public static ApiResponse fail(int code) {
        return new ApiResponse(code, ErrorCode.text(code), null);
    }

    public static ApiResponse fail(int code, String message) {
        return new ApiResponse(code, message == null ? ErrorCode.text(code) : message, null);
    }

    public static ApiResponse fail(int code, String message, Object data) {
        return new ApiResponse(code, message == null ? ErrorCode.text(code) : message, data);
    }

    /** 分页结构：{@code {total:n, page:p, size:s, list:[...]}} */
    public static Object page(java.util.List<?> list, long total, int page, int pageSize) {
        return pageMap(list, total, page, pageSize);
    }

    /** 同 {@link #page}，但返回可直接读写、可继续追加字段的 Map。 */
    public static LinkedHashMap<String, Object> pageMap(java.util.List<?> list, long total,
                                                        int page, int pageSize) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        m.put("total", total);
        m.put("page", page);
        m.put("size", pageSize);
        m.put("pageSize", pageSize);
        m.put("list", list);
        return m;
    }

    public int getCode() {
        return code;
    }

    public void setCode(int code) {
        this.code = code;
    }

    public String getMessage() {
        return message;
    }

    public void setMessage(String message) {
        this.message = message;
    }

    public Object getData() {
        return data;
    }

    public void setData(Object data) {
        this.data = data;
    }
}
