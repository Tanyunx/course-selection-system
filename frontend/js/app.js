/**
 * 应用外壳：登录、角色菜单、哈希路由、全局状态。
 */

import { api, getToken, setToken, ApiError } from './api.js';
import { $, esc, toast, openModal, loadingState } from './ui.js';
import * as student from './views/student.js';
import * as teacher from './views/teacher.js';
import * as admin from './views/admin.js';
import * as sys from './views/sys.js';

export const state = {
  profile: null,
  term: null,
  terms: [],
  filters: null,
  unread: 0,
  context: null,
};

const ROLE_TEXT = { 1: '学生', 2: '教师', 3: '教务管理员', 4: '系统管理员' };

const MENUS = {
  1: [
    {
      group: '选课',
      items: [
        { path: 'courses', label: '选课中心', icon: '🔍', render: student.renderCourses },
        { path: 'timetable', label: '我的课表', icon: '🗓', render: student.renderTimetable },
        { path: 'my', label: '我的选课', icon: '📚', render: student.renderMyCourses },
        { path: 'waitlist', label: '我的候补', icon: '⏳', render: student.renderWaitlist },
      ],
    },
    {
      group: '个人',
      items: [
        { path: 'notices', label: '通知中心', icon: '🔔', render: student.renderNotices, badge: true },
        { path: 'rules', label: '选课规则', icon: '📋', render: student.renderRules },
      ],
    },
  ],
  2: [
    {
      group: '教学',
      items: [
        { path: 't/offerings', label: '我的开课', icon: '📖', render: teacher.renderOfferings },
        { path: 't/students', label: '选课名单', icon: '👥', render: teacher.renderStudents },
      ],
    },
    { group: '个人', items: [{ path: 'notices', label: '通知中心', icon: '🔔', render: student.renderNotices, badge: true }] },
  ],
  3: [
    {
      group: '教务',
      items: [
        { path: 'a/dashboard', label: '数据概览', icon: '📊', render: admin.renderDashboard },
        { path: 'a/courses', label: '课程目录', icon: '📚', render: admin.renderCourses },
        { path: 'a/offerings', label: '开课计划', icon: '🗂', render: admin.renderOfferings },
        { path: 'a/quota', label: '名额管理', icon: '📈', render: admin.renderQuota },
        { path: 'a/batches', label: '选课批次', icon: '⏱', render: admin.renderBatches },
        { path: 'a/credits', label: '学分规则', icon: '🎯', render: admin.renderCredits },
        { path: 'a/announcements', label: '公告发布', icon: '📢', render: admin.renderAnnouncements },
      ],
    },
    { group: '其他', items: [{ path: 'notices', label: '通知中心', icon: '🔔', render: student.renderNotices, badge: true }] },
  ],
  4: [
    {
      group: '系统',
      items: [
        { path: 's/users', label: '用户与权限', icon: '👤', render: sys.renderUsers },
        { path: 's/logs', label: '审计日志', icon: '📜', render: sys.renderLogs },
        { path: 's/monitor', label: '运行监控', icon: '📡', render: sys.renderMonitor },
      ],
    },
    { group: '其他', items: [{ path: 'notices', label: '通知中心', icon: '🔔', render: student.renderNotices, badge: true }] },
  ],
};

export const ctx = {
  state,
  go(path) {
    window.location.hash = '#/' + path.replace(/^\/+/, '');
  },
  async refreshUnread() {
    if (!state.profile) return;
    try {
      const r = await api.get('/api/notices', { page: 1, size: 1, unread: true });
      state.unread = r.unread;
      renderUnread();
    } catch (e) {
      /* 忽略 */
    }
  },
  async reload() {
    await renderRoute(true);
  },
  setSub(text) {
    const el = $('#page-sub');
    if (el) el.textContent = text || '';
  },
};

/* ---------------- 登录 ---------------- */

const DEMO = [
  { label: '学生 陈嘉禾', username: '2024001' },
  { label: '学生 林知遥', username: '2024002' },
  { label: '教师 张明远', username: 'teacher001' },
  { label: '教务 周教务', username: 'academic' },
  { label: '系统 孙运维', username: 'sysadmin' },
];

function renderDemoList() {
  const box = $('#demo-list');
  box.innerHTML = DEMO.map(
    (d) => `<button type="button" data-username="${esc(d.username)}">${esc(d.label)}</button>`
  ).join('');
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('#login-username').value = b.dataset.username;
      $('#login-password').focus();
    };
  });
}

let captchaId = null;

async function loadCaptcha() {
  // 题目显示在刷新按钮上（按钮即题目），元素 id 为 captcha-refresh
  const btn = $('#captcha-refresh');
  if (!btn) return;
  btn.textContent = '加载中…';
  try {
    const r = await api.get('/api/auth/captcha');
    captchaId = r.captchaId;
    btn.textContent = r.question;
  } catch (e) {
    captchaId = null;
    btn.textContent = '点击重试';
  }
}

function showLogin() {
  $('#app').hidden = true;
  $('#login-page').hidden = false;
  renderDemoList();
  loadCaptcha(); // 预取验证码，登录失败需要作答时题目已就绪
  $('#login-username').focus();
}

function showApp() {
  $('#login-page').hidden = true;
  $('#app').hidden = false;
}

async function doLogin(username, password) {
  const body = { username, password };
  if (!$('#captcha-field').hidden && captchaId) {
    body.captchaId = captchaId;
    body.captchaAnswer = $('#login-captcha').value;
  }
  const r = await api.post('/api/auth/login', body);
  setToken(r.token);
  state.profile = r.profile;
}

function bindLogin() {
  $('#captcha-refresh').onclick = loadCaptcha;

  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    const err = $('#login-error');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      await doLogin($('#login-username').value.trim(), $('#login-password').value);
      await boot();
    } catch (e2) {
      err.textContent = e2.message || '登录失败';
      err.hidden = false;
      if (e2 instanceof ApiError && e2.data && e2.data.needCaptcha) {
        $('#captcha-field').hidden = false;
        await loadCaptcha();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  };
}

/* ---------------- 主界面 ---------------- */

function renderNav() {
  if (!state.profile) return;
  const role = state.profile.role;
  const groups = MENUS[role] || [];
  const currentPath = getPath();
  const nav = $('#side-nav');
  nav.innerHTML = groups
    .map(
      (g) => `
      <div class="side-group-title">${esc(g.group)}</div>
      ${g.items
        .map(
          (it) => `<button class="nav-item ${it.path === currentPath ? 'active' : ''}" data-path="${esc(it.path)}">
             <span class="ni">${it.icon}</span><span>${esc(it.label)}</span>
             ${it.badge ? '<span class="ni-count" id="nav-unread" hidden></span>' : ''}
           </button>`
        )
        .join('')}`
    )
    .join('');
  nav.querySelectorAll('.nav-item').forEach((b) => {
    b.onclick = () => {
      ctx.go(b.dataset.path);
      $('#sidebar').classList.remove('open');
    };
  });
}

function renderUnread() {
  const badge = $('#unread-badge');
  const nav = $('#nav-unread');
  if (state.unread > 0) {
    badge.hidden = false;
    badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
    if (nav) {
      nav.hidden = false;
      nav.textContent = String(state.unread);
    }
  } else {
    badge.hidden = true;
    if (nav) nav.hidden = true;
  }
}

function renderUser() {
  const p = state.profile;
  if (!p) return;
  $('#user-avatar').textContent = (p.realName || '?').slice(0, 1);
  $('#user-name').textContent = p.realName || p.username;
  const parts = [ROLE_TEXT[p.role]];
  if (p.studentNo) parts.push(p.studentNo);
  if (p.teacherNo) parts.push(p.teacherNo);
  if (p.grade) parts.push(p.grade + ' 级');
  $('#user-role').textContent = parts.join(' · ');

  $('#side-foot').innerHTML = `
    <div class="sf-title">当前学期</div>
    <div class="sf-value">${esc(state.term ? state.term.name : '—')}</div>`;
}

function getPath() {
  const h = window.location.hash.replace(/^#\/?/, '');
  return h || defaultPath();
}

function defaultPath() {
  const role = state.profile ? state.profile.role : 1;
  return (MENUS[role] && MENUS[role][0].items[0].path) || 'notices';
}

function findRoute(path) {
  const role = state.profile ? state.profile.role : 1;
  const groups = MENUS[role] || [];
  for (const g of groups) {
    const hit = g.items.find((i) => i.path === path);
    if (hit) return hit;
  }
  return null;
}

async function renderRoute(force = false) {
  // 未登录（含刚退出登录）时不渲染业务页面，避免残留 hash 触发空引用
  if (!state.profile) return;
  let path = getPath();
  let route = findRoute(path);
  if (!route) {
    path = defaultPath();
    route = findRoute(path);
    if (!route) return;
  }
  renderNav();
  const content = $('#content');
  content.innerHTML = loadingState();
  try {
    await route.render(content, { ...ctx, path });
  } catch (e) {
    if (e instanceof ApiError && e.code === 1002) return;
    content.innerHTML = `<div class="alert alert-error"><span class="a-ic">✕</span><span>页面加载失败：${esc(
      e.message || '未知错误'
    )}</span></div>`;
  }
}

function bindShell() {
  $('#menu-toggle').onclick = () => $('#sidebar').classList.toggle('open');
  $('#bell-btn').onclick = () => ctx.go('notices');
  $('#logout-btn').onclick = async () => {
    try {
      await api.post('/api/auth/logout');
    } catch (e) {
      /* 忽略 */
    }
    setToken('');
    state.profile = null;
    window.location.hash = '';
    showLogin();
  };
  window.addEventListener('hashchange', () => renderRoute());
  window.addEventListener('cs:unauthorized', () => {
    state.profile = null;
    showLogin();
    toast('登录状态已失效，请重新登录', 'warn');
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  if (!state.profile) {
    const me = await api.get('/api/auth/me');
    state.profile = me.profile;
    state.unread = me.unreadNotice;
  }
  const t = await api.get('/api/terms/current');
  state.term = t.current;
  state.terms = t.terms;
  state.filters = await api.get('/api/meta/filters');

  $('#term-chip').textContent = state.term ? `${state.term.name}` : '未设置学期';
  renderUser();
  showApp();
  if (!window.location.hash) window.location.hash = '#/' + defaultPath();
  await renderRoute();
  renderUnread();
  await ctx.refreshUnread();
}

async function main() {
  bindLogin();
  bindShell();
  if (getToken()) {
    try {
      await boot();
      return;
    } catch (e) {
      setToken('');
    }
  }
  showLogin();
}

main();
