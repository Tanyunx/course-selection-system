/**
 * 接口访问层：统一令牌、统一返回体解析、错误码映射、写操作 requestId 生成。
 * 对应设计文档 2.4 接口设计。
 */

const TOKEN_KEY = 'cs_token';

/**
 * 后端 API 的基地址。
 *
 * 生产 / 推荐用法：留空（返回空串），接口写成相对路径 `/api/xxx`。
 * 前端由 Nginx 托管、`/api` 反代到后端，两者同源，天然没有跨域问题。
 *
 * 本地开发时如果前端与后端不在同一个端口上（例如前端跑在 5500、后端在 3000），
 * 可以用下面两种方式之一指定后端地址，无需改动代码：
 *   1. 访问时带上查询参数：http://127.0.0.1:5500/?api=http://127.0.0.1:3000
 *   2. 在页面里提前设置：window.__API_BASE__ = 'http://127.0.0.1:3000'
 * 更省事的做法是用仓库自带的代理脚本 `node tools/serve-frontend.js`，
 * 它同时托管前端并把 /api 转发到后端，此时也不需要配置这里。
 */
function apiBase() {
  if (typeof window === 'undefined') return '';
  const strip = (v) => String(v).replace(/\/+$/, '');
  if (window.__API_BASE__) return strip(window.__API_BASE__);
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('api');
    if (fromQuery) return strip(fromQuery);
  } catch (e) {
    /* 取不到就用同源 */
  }
  return '';
}

export const ERR_TEXT = {
  0: '操作成功',
  1001: '账号或密码错误，请重新输入',
  1002: '登录状态已失效，请重新登录',
  1003: '当前角色无此操作权限',
  2001: '该课程名额已满，可加入候补',
  2002: '与已选课程时间冲突',
  2003: '选课后将超出本学期学分上限',
  2004: '需先修并通过指定先修课程',
  2005: '当前不在你可选的选课批次时间内',
  2006: '你已选该课程，无需重复选课',
  2007: '你已加入候补',
  2008: '已超过退课截止时间，无法退课',
  2009: '目标课程不可选，原课程未变动',
  2010: '候补机会已过期，名额已顺延他人',
  2011: '你尚未选修该课程',
  2012: '该开课已停开，无法操作',
  2013: '你不在该课程的候补队列中',
  2014: '未找到对应的开课记录',
  9001: '当前访问过于频繁，请稍后再试',
  9002: '系统繁忙，请稍后重试',
  9003: '请求参数有误，请检查后重试',
};

export class ApiError extends Error {
  constructor(code, message, data) {
    super(message || ERR_TEXT[code] || '操作失败');
    this.code = code;
    this.data = data || null;
  }
}

// 令牌内存兜底：file:// 等受限环境下浏览器可能禁用 localStorage
let memoryToken = '';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || memoryToken || '';
  } catch (e) {
    return memoryToken;
  }
}
export function setToken(token) {
  memoryToken = token || '';
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    /* 降级为内存令牌，不影响本次会话 */
  }
}

export function newRequestId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'req-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

async function request(method, path, { body, query } = {}) {
  let url = apiBase() + path;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.append(k, v);
    });
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(9002, '网络连接失败，请检查服务是否已启动');
  }

  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    throw new ApiError(9002, '服务返回格式异常');
  }

  if (!json || typeof json.code !== 'number') throw new ApiError(9002, '服务返回格式异常');
  if (json.code !== 0) {
    if (json.code === 1002) {
      setToken('');
      window.dispatchEvent(new CustomEvent('cs:unauthorized'));
    }
    throw new ApiError(json.code, json.message, json.data);
  }
  return json.data;
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  del: (path, body) => request('DELETE', path, { body }),
};

/** 写操作统一附加 requestId，满足幂等要求 */
export function writeBody(payload) {
  return { ...(payload || {}), requestId: newRequestId() };
}
