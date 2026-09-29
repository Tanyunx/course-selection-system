'use strict';

/**
 * 统一返回体：code 为 0 表示成功，非 0 为错误码；message 为提示文案；data 为业务数据。
 */

function ok(res, data = null, message) {
  return res.json({ code: 0, message: message || '操作成功', data });
}

function fail(res, code, message, extra, httpStatus) {
  return res.status(httpStatus || 200).json({
    code,
    message: message || '操作失败',
    data: extra === undefined ? null : extra,
  });
}

/** 分页返回体：total、page、size、list */
function page(list, total, pageNo, size) {
  return { total, page: pageNo, size, list };
}

module.exports = { ok, fail, page };
