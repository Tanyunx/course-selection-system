/**
 * 通用界面工具：DOM 助手、提示、模态框、二次确认、格式化函数。
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** HTML 转义，防止 XSS（接口数据插入模板前统一处理） */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function relativeTime(v) {
  if (!v) return '';
  const d = new Date(v).getTime();
  const diff = Date.now() - d;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtTime(v);
}

/* ---------------- Toast ---------------- */

export function toast(message, type = 'info', detail = '') {
  const root = document.getElementById('toast-root');
  const icon = { success: '✓', error: '✕', warn: '!', info: 'i' }[type] || 'i';
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `<span class="t-ic">${icon}</span><span class="t-text">${esc(message)}${
    detail ? `<span class="t-detail">${esc(detail)}</span>` : ''
  }</span>`;
  root.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(-6px)';
    setTimeout(() => node.remove(), 220);
  }, type === 'error' ? 4200 : 2600);
}

/* ---------------- Modal ---------------- */

export function openModal({ title, body, footer, wide = false, onMount }) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title || '')}">
      <div class="modal-head">
        <h3>${esc(title || '')}</h3>
        <button class="icon-btn close" aria-label="关闭" data-close>✕</button>
      </div>
      <div class="modal-body"></div>
      ${footer === null ? '' : '<div class="modal-foot"></div>'}
    </div>`;
  const bodyEl = mask.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);

  const footEl = mask.querySelector('.modal-foot');
  if (footEl && footer) {
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else if (footer instanceof Node) footEl.appendChild(footer);
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    mask.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  mask.querySelector('[data-close]').onclick = () => close();
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  document.addEventListener('keydown', onKey);
  root.appendChild(mask);
  if (onMount) onMount({ mask, body: bodyEl, footer: footEl, close });
  const focusable = mask.querySelector('input, select, textarea, button:not([data-close])');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { close, mask, body: bodyEl, footer: footEl };
}

export function confirmDialog({ title = '请确认', text = '', confirmText = '确定', danger = false, detail = '' }) {
  return new Promise((resolve) => {
    let settled = false;
    openModal({
      title,
      body: `<p style="font-size:13.5px;color:#475467;line-height:1.7">${esc(text)}</p>${
        detail ? `<div class="alert alert-warn mt-16"><span class="a-ic">!</span><span>${esc(detail)}</span></div>` : ''
      }`,
      footer: `<button class="btn" data-cancel>取消</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`,
      onMount: ({ footer, close, mask }) => {
        footer.querySelector('[data-cancel]').onclick = () => {
          settled = true;
          close();
          resolve(false);
        };
        footer.querySelector('[data-ok]').onclick = () => {
          settled = true;
          close();
          resolve(true);
        };
        mask.addEventListener('click', (e) => {
          if (e.target === mask && !settled) resolve(false);
        });
      },
    });
  });
}

/** 空状态 */
export function emptyState(text, icon = '📭') {
  return `<div class="empty"><div class="empty-icon">${icon}</div><p>${esc(text)}</p></div>`;
}

export function loadingState(text = '加载中…') {
  return `<div class="loading"><div class="spinner"></div>${esc(text)}</div>`;
}

/** 状态标签（表 6 选课按钮状态） */
export const STATUS_META = {
  AVAILABLE: { text: '可选', cls: 'badge-green' },
  FULL: { text: '已满', cls: 'badge-gray' },
  CONFLICT: { text: '时间冲突', cls: 'badge-amber' },
  INELIGIBLE: { text: '条件不符', cls: 'badge-gray' },
  OUT_OF_BATCH: { text: '批次外', cls: 'badge-gray' },
  SELECTED: { text: '已选', cls: 'badge-blue' },
  WAITLISTED: { text: '候补中', cls: 'badge-purple' },
  CLOSED: { text: '已停开', cls: 'badge-red' },
};

export function statusBadge(status) {
  const meta = STATUS_META[status] || { text: status, cls: 'badge-gray' };
  return `<span class="badge ${meta.cls}">${esc(meta.text)}</span>`;
}

export const HEAT_CLS = { 高: 'badge-red', 中: 'badge-amber', 低: 'badge-green' };

export function heatBadge(heat) {
  return `<span class="badge ${HEAT_CLS[heat] || 'badge-gray'}">热度${esc(heat)}</span>`;
}

export function heatProgress(enrolled, capacity) {
  const rate = capacity ? Math.min(1, enrolled / capacity) : 0;
  const cls = rate >= 0.9 ? 'high' : rate >= 0.6 ? 'mid' : 'low';
  return `<div class="progress ${cls}"><i style="width:${(rate * 100).toFixed(1)}%"></i></div>`;
}

/** 防抖 */
export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** 表单取值 */
export function formValues(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((node) => {
    if (node.type === 'checkbox') out[node.name] = node.checked;
    else if (node.type === 'number') out[node.name] = node.value === '' ? '' : Number(node.value);
    else out[node.name] = node.value;
  });
  return out;
}

export const WEEKDAY_TEXT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const PARITY_TEXT = { 0: '全周', 1: '单周', 2: '双周' };

/**
 * 一天内的节次时间表，与学校《课时表》一致（每节 40 分钟）。
 * 上午 1~5 节、下午 6~10 节、晚上 11~13 节。
 * 注意：服务端同名常量在 server/utils/period.js，两处需保持一致。
 */
export const PERIOD_TIME = {
  1: '08:00-08:40', 2: '08:45-09:25', 3: '09:45-10:25', 4: '10:30-11:10', 5: '11:15-11:55',
  6: '13:00-13:40', 7: '13:45-14:25', 8: '14:45-15:25', 9: '15:30-16:10', 10: '16:15-16:55',
  11: '18:00-18:40', 12: '18:45-19:25', 13: '19:30-20:10',
};

/** 每天可排课的最大节次 */
export const PERIOD_COUNT = 13;

/** 每节所属时段（上午 / 下午 / 晚上），用于课表左侧时段列 */
export const PERIOD_BAND = {
  1: '上午', 2: '上午', 3: '上午', 4: '上午', 5: '上午',
  6: '下午', 7: '下午', 8: '下午', 9: '下午', 10: '下午',
  11: '晚上', 12: '晚上', 13: '晚上',
};

/** 每节所属大节（一 ~ 五），与课时表的大节划分一致 */
export const PERIOD_GROUP = {
  1: '一', 2: '一', 3: '二', 4: '二', 5: '二',
  6: '三', 7: '三', 8: '四', 9: '四', 10: '四',
  11: '五', 12: '五', 13: '五',
};

/** 把节次区间格式化为起始时间，如 (1, 2) → '08:00~09:25' */
export function periodRangeText(start, end) {
  const a = PERIOD_TIME[start];
  const b = PERIOD_TIME[end] || a;
  if (!a) return '';
  return `${a.slice(0, 5)}~${(b || a).slice(6)}`;
}
