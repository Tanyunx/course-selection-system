/**
 * 系统管理端页面（见设计文档 3.5）。
 */

import { api } from '../api.js';
import { $, $$, esc, toast, openModal, confirmDialog, emptyState, loadingState, fmtTime } from '../ui.js';

/* ---------------- 用户与权限 ---------------- */

export async function renderUsers(root, ctx) {
  let keyword = '';
  let role = '';
  let status = '';

  const paint = async () => {
    const box = $('#user-box');
    box.innerHTML = loadingState();
    const d = await api.get('/api/admin/users', { keyword, role, status, size: 50 });

    box.innerHTML = `
      ${
        d.list.length
          ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>学号 / 工号</th><th>年级 / 学院</th><th>最后登录</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>${d.list
                .map(
                  (u) => `<tr>
                  <td>${esc(u.username)}</td>
                  <td class="course-name">${esc(u.real_name)}</td>
                  <td><span class="badge ${
                    u.role === 4 ? 'badge-red' : u.role === 3 ? 'badge-purple' : u.role === 2 ? 'badge-blue' : 'badge-gray'
                  }">${esc(u.roleText)}</span></td>
                  <td>${esc(u.student_no || u.teacher_no || '—')}</td>
                  <td>${esc(u.grade ? u.grade + ' 级' : '')}${u.college || u.teacher_college ? ' ' + esc(u.college || u.teacher_college) : ''}${
                    !u.grade && !u.college && !u.teacher_college ? '—' : ''
                  }</td>
                  <td>${u.last_login_at ? fmtTime(u.last_login_at) : '—'}</td>
                  <td>${u.status === 1 ? '<span class="badge badge-green">正常</span>' : '<span class="badge badge-red">禁用</span>'}</td>
                  <td><div class="row-actions">
                    <button class="btn btn-sm" data-edit="${u.id}">编辑</button>
                    <button class="btn btn-sm" data-toggle="${u.id}" data-status="${u.status}" data-name="${esc(u.real_name)}">${
                    u.status === 1 ? '禁用' : '启用'
                  }</button>
                  </div></td>
                </tr>`
                )
                .join('')}</tbody>
            </table></div>`
          : emptyState('没有匹配的用户', '👤')
      }
      <div class="pager"><span class="page-info">共 ${d.total} 个用户</span></div>
    `;

    $$('[data-edit]', box).forEach((b) => {
      b.onclick = () => openUserForm(d.list.find((u) => u.id === Number(b.dataset.edit)), paint);
    });
    $$('[data-toggle]', box).forEach((b) => {
      b.onclick = async () => {
        const nextStatus = Number(b.dataset.status) === 1 ? 0 : 1;
        const ok = await confirmDialog({
          title: nextStatus === 0 ? '禁用账号' : '启用账号',
          text: `确认${nextStatus === 0 ? '禁用' : '启用'}账号「${b.dataset.name}」？`,
          detail: nextStatus === 0 ? '禁用后该账号将无法登录系统。' : '',
          confirmText: '确认',
          danger: nextStatus === 0,
        });
        if (!ok) return;
        try {
          await api.put(`/api/admin/users/${b.dataset.toggle}`, { status: nextStatus });
          toast(nextStatus === 0 ? '账号已禁用' : '账号已启用', 'success');
          await paint();
        } catch (e) {
          toast('操作失败', 'error', e.message);
        }
      };
    });
  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>用户与权限</h2><p class="sub">账号增删改查、角色分配、状态启用与禁用</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="btn-new-user">新增用户</button></div>
    </div>
    <div class="card">
      <div class="toolbar">
        <div class="field-inline grow"><span>账号 / 姓名</span>
          <input type="text" id="u-keyword" placeholder="输入关键字搜索" /></div>
        <div class="field-inline" style="min-width:140px"><span>角色</span>
          <select id="u-role"><option value="">全部角色</option>
            <option value="1">学生</option><option value="2">教师</option>
            <option value="3">教务管理员</option><option value="4">系统管理员</option></select></div>
        <div class="field-inline" style="min-width:120px"><span>状态</span>
          <select id="u-status"><option value="">全部</option><option value="1">正常</option><option value="0">禁用</option></select></div>
      </div>
      <div class="card-body tight" id="user-box"></div>
    </div>
  `;

  $('#u-keyword').oninput = (e) => {
    keyword = e.target.value.trim();
    clearTimeout(window.__ut);
    window.__ut = setTimeout(paint, 320);
  };
  $('#u-role').onchange = (e) => {
    role = e.target.value;
    paint();
  };
  $('#u-status').onchange = (e) => {
    status = e.target.value;
    paint();
  };
  $('#btn-new-user').onclick = () => openUserForm(null, paint);

  await paint();
}

function openUserForm(user, after) {
  const isEdit = !!user;
  const m = openModal({
    title: isEdit ? `编辑用户：${user.real_name}` : '新增用户',
    body: isEdit
      ? `
        <div class="form-row">
          <label class="field-inline"><span>账号</span><input type="text" value="${esc(user.username)}" disabled /></label>
          <label class="field-inline"><span>姓名</span><input type="text" id="fu-name" value="${esc(user.real_name)}" /></label>
        </div>
        <div class="form-row mt-12">
          <label class="field-inline"><span>角色</span>
            <select id="fu-role">
              <option value="1" ${user.role === 1 ? 'selected' : ''}>学生</option>
              <option value="2" ${user.role === 2 ? 'selected' : ''}>教师</option>
              <option value="3" ${user.role === 3 ? 'selected' : ''}>教务管理员</option>
              <option value="4" ${user.role === 4 ? 'selected' : ''}>系统管理员</option>
            </select></label>
          <label class="field-inline"><span>状态</span>
            <select id="fu-status">
              <option value="1" ${user.status === 1 ? 'selected' : ''}>正常</option>
              <option value="0" ${user.status === 0 ? 'selected' : ''}>禁用</option>
            </select></label>
        </div>
        <label class="field-inline mt-12"><span>重置密码（留空则不修改）</span>
          <input type="password" id="fu-pwd" placeholder="输入新密码" /></label>
      `
      : `
        <div class="form-row">
          <label class="field-inline"><span>账号 *</span><input type="text" id="fu-username" placeholder="学号 / 工号 / 管理员账号" /></label>
          <label class="field-inline"><span>姓名 *</span><input type="text" id="fu-name" placeholder="真实姓名" /></label>
        </div>
        <div class="form-row mt-12">
          <label class="field-inline"><span>角色 *</span>
            <select id="fu-role">
              <option value="1">学生</option><option value="2">教师</option>
              <option value="3">教务管理员</option><option value="4">系统管理员</option>
            </select></label>
          <label class="field-inline"><span>初始密码 *</span><input type="password" id="fu-pwd" placeholder="登录密码" /></label>
        </div>
        <div id="fu-extra" class="mt-12"></div>
      `,
    footer: `<button class="btn" data-close-x>取消</button><button class="btn btn-primary" id="fu-save">保存</button>`,
  });

  function renderExtra() {
    if (isEdit) return;
    const role = m.body.querySelector('#fu-role').value;
    const box = m.body.querySelector('#fu-extra');
    if (!box) return;
    if (role === '1') {
      box.innerHTML = `<div class="form-row">
        <label class="field-inline"><span>学号</span><input type="text" id="fu-sno" placeholder="如 2024009" /></label>
        <label class="field-inline"><span>年级</span><input type="text" id="fu-grade" placeholder="如 2024" /></label>
        <label class="field-inline"><span>学院</span><input type="text" id="fu-college" placeholder="如 计算机学院" /></label>
        <label class="field-inline"><span>专业</span><input type="text" id="fu-major" placeholder="如 软件工程" /></label>
      </div>`;
    } else if (role === '2') {
      box.innerHTML = `<div class="form-row">
        <label class="field-inline"><span>工号</span><input type="text" id="fu-tno" placeholder="如 T1005" /></label>
        <label class="field-inline"><span>学院</span><input type="text" id="fu-college" placeholder="如 计算机学院" /></label>
        <label class="field-inline"><span>职称</span><input type="text" id="fu-title" placeholder="如 讲师" /></label>
      </div>`;
    } else {
      box.innerHTML = '';
    }
  }

  if (!isEdit) {
    m.body.querySelector('#fu-role').onchange = renderExtra;
    renderExtra();
  }

  m.footer.querySelector('[data-close-x]').onclick = () => m.close();
  m.footer.querySelector('#fu-save').onclick = async () => {
    const body = {
      realName: (m.body.querySelector('#fu-name') || {}).value || '',
      role: Number(m.body.querySelector('#fu-role').value),
    };
    if (isEdit) {
      body.status = Number(m.body.querySelector('#fu-status').value);
      const p = m.body.querySelector('#fu-pwd').value;
      if (p) body.newPassword = p;
    } else {
      body.username = m.body.querySelector('#fu-username').value.trim();
      body.password = m.body.querySelector('#fu-pwd').value;
      const g = (id) => {
        const el = m.body.querySelector(id);
        return el ? el.value.trim() : '';
      };
      if (body.role === 1) {
        body.studentNo = g('#fu-sno');
        body.grade = g('#fu-grade');
        body.college = g('#fu-college');
        body.major = g('#fu-major');
      } else if (body.role === 2) {
        body.teacherNo = g('#fu-tno');
        body.college = g('#fu-college');
        body.title = g('#fu-title');
      }
      if (!body.username || !body.password || !body.realName) {
        toast('请填写账号、姓名与密码', 'error');
        return;
      }
    }
    try {
      if (isEdit) await api.put(`/api/admin/users/${user.id}`, body);
      else await api.post('/api/admin/users', body);
      toast(isEdit ? '用户已更新' : '用户已创建', 'success');
      m.close();
      await after();
    } catch (e) {
      toast('保存失败', 'error', e.message);
    }
  };
}

/* ---------------- 审计日志 ---------------- */

export async function renderLogs(root, ctx) {
  let filters = { action: '', username: '', result: '', page: 1 };

  const paint = async () => {
    const box = $('#log-box');
    box.innerHTML = loadingState();
    const d = await api.get('/api/admin/audit-logs', { ...filters, size: 30 });

    box.innerHTML = `
      ${
        d.list.length
          ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>时间</th><th>操作人</th><th>操作类型</th><th>目标</th><th>IP</th><th>结果</th><th>详情</th></tr></thead>
              <tbody>${d.list
                .map(
                  (l) => `<tr>
                  <td class="nowrap">${fmtTime(l.created_at)}</td>
                  <td>${esc(l.username || '—')}</td>
                  <td><span class="tag">${esc(l.action)}</span></td>
                  <td>${esc(l.target_type || '—')}${l.target_id ? ' #' + l.target_id : ''}</td>
                  <td>${esc(l.ip || '—')}</td>
                  <td>${l.result === 1 ? '<span class="badge badge-green">成功</span>' : '<span class="badge badge-red">失败</span>'}</td>
                  <td class="cell-sub">${esc(l.detail || '')}</td>
                </tr>`
                )
                .join('')}</tbody>
            </table></div>`
          : emptyState('没有匹配的日志', '📜')
      }
      <div class="pager">
        <span class="page-info">共 ${d.total} 条，第 ${d.page} / ${Math.max(1, Math.ceil(d.total / d.size))} 页</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-page="prev" ${d.page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn btn-sm" data-page="next" ${d.page * d.size >= d.total ? 'disabled' : ''}>下一页</button>
      </div>
    `;

    $$('[data-page]', box).forEach((b) => {
      b.onclick = () => {
        filters.page += b.dataset.page === 'next' ? 1 : -1;
        paint();
      };
    });

    const sel = $('#l-action');
    if (sel.options.length <= 1) {
      sel.innerHTML =
        '<option value="">全部操作类型</option>' + d.actions.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
      sel.value = filters.action;
    }
  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>审计日志</h2><p class="sub">关键操作留痕：含操作人、IP、结果与失败原因，保留 180 天</p></div>
    </div>
    <div class="card">
      <div class="toolbar">
        <div class="field-inline" style="min-width:190px"><span>操作类型</span>
          <select id="l-action"><option value="">全部操作类型</option></select></div>
        <div class="field-inline grow"><span>操作人账号</span>
          <input type="text" id="l-user" placeholder="如 2024001" /></div>
        <div class="field-inline" style="min-width:130px"><span>结果</span>
          <select id="l-result"><option value="">全部</option><option value="1">成功</option><option value="0">失败</option></select></div>
      </div>
      <div class="card-body tight" id="log-box"></div>
    </div>
  `;

  $('#l-action').onchange = (e) => {
    filters.action = e.target.value;
    filters.page = 1;
    paint();
  };
  $('#l-user').oninput = (e) => {
    filters.username = e.target.value.trim();
    filters.page = 1;
    clearTimeout(window.__lt);
    window.__lt = setTimeout(paint, 320);
  };
  $('#l-result').onchange = (e) => {
    filters.result = e.target.value;
    filters.page = 1;
    paint();
  };

  await paint();
}

/* ---------------- 运行监控 ---------------- */

export async function renderMonitor(root, ctx) {
  const paint = async () => {
    const box = $('#monitor-box');
    const d = await api.get('/api/admin/monitor');
    box.innerHTML = `
      <div class="stat-grid mb-16">
        <div class="stat">
          <div class="label">接口成功率</div>
          <div class="value">${d.successRate}<small>%</small></div>
          <div class="hint">累计请求 ${d.totalRequests} 次，失败 ${d.failedRequests} 次</div>
        </div>
        <div class="stat">
          <div class="label">选课写接口 P95</div>
          <div class="value">${d.writeP95Ms}<small>ms</small></div>
          <div class="hint">平均 ${d.writeAvgMs} ms；目标 P95 ≤ 2000 ms</div>
        </div>
        <div class="stat">
          <div class="label">当前在线人数</div>
          <div class="value">${d.onlineUsers}<small>人</small></div>
          <div class="hint">按 ${d.uptimeSeconds} 秒运行时长内的有效会话统计</div>
        </div>
        <div class="stat">
          <div class="label">排队队列长度</div>
          <div class="value">${d.queueLength}<small>人</small></div>
          <div class="hint">未启用网关排队（可选增强项）</div>
        </div>
        <div class="stat">
          <div class="label">缓存与库余量差值</div>
          <div class="value">${d.cacheDiff}</div>
          <div class="hint">未引入 Redis，差值恒为 0</div>
        </div>
        <div class="stat">
          <div class="label">候补与选课规模</div>
          <div class="value">${d.waitlistTotal}<small>候补</small></div>
          <div class="hint">有效选课记录 ${d.activeEnrollment} 条</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>告警阈值检查</h3></div>
          <div class="card-body tight">
            <div class="table-wrap"><table class="data">
              <thead><tr><th>指标</th><th class="num">当前值</th><th>阈值</th><th>状态</th></tr></thead>
              <tbody>${d.thresholds
                .map(
                  (t) => `<tr>
                  <td>${esc(t.name)}</td>
                  <td class="num">${t.value}${esc(t.unit)}</td>
                  <td>${esc(t.threshold)}</td>
                  <td>${
                    t.level === 'ok'
                      ? '<span class="badge badge-green">正常</span>'
                      : '<span class="badge badge-amber">告警</span>'
                  }</td>
                </tr>`
                )
                .join('')}</tbody>
            </table></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>错误码分布</h3></div>
          <div class="card-body tight">
            ${
              d.errorsByCode.length
                ? `<div class="table-wrap"><table class="data">
                    <thead><tr><th>错误码</th><th class="num">次数</th></tr></thead>
                    <tbody>${d.errorsByCode.map((e) => `<tr><td>${e.code}</td><td class="num">${e.count}</td></tr>`).join('')}</tbody>
                  </table></div>`
                : emptyState('暂无错误记录', '✓')
            }
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>接口调用统计</h3><div class="head-actions"><span class="small muted">按调用次数排序，取前 12 条</span></div></div>
        <div class="card-body tight">
          <div class="table-wrap"><table class="data">
            <thead><tr><th>接口</th><th class="num">调用次数</th><th class="num">失败次数</th><th class="num">错误率</th><th class="num">平均耗时</th></tr></thead>
            <tbody>${d.topPaths
              .map(
                (p) => `<tr>
                <td><span class="tag">${esc(p.path)}</span></td>
                <td class="num">${p.total}</td>
                <td class="num">${p.fail}</td>
                <td class="num">${p.errorRate}%</td>
                <td class="num">${p.avgMs} ms</td>
              </tr>`
              )
              .join('')}</tbody>
          </table></div>
        </div>
      </div>
    `;
  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>运行监控</h2><p class="sub">接口成功率与响应时间、在线人数、队列长度、缓存差值，支持阈值告警</p></div>
      <div class="head-actions"><button class="btn" id="btn-refresh-monitor">刷新</button></div>
    </div>
    <div id="monitor-box"></div>
  `;
  $('#btn-refresh-monitor').onclick = paint;
  await paint();
}
