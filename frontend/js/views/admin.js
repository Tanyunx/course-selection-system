/**
 * 教务管理端页面（见设计文档 3.4）。
 */

import { api } from '../api.js';
import { $, $$, esc, toast, openModal, confirmDialog, emptyState, loadingState, fmtTime } from '../ui.js';
import { scheduleEditor } from '../scheduleEditor.js';

/* ---------------- 数据概览 ---------------- */

export async function renderDashboard(root, ctx) {
  root.innerHTML = loadingState();
  const d = await api.get('/api/admin/dashboard');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2>数据概览</h2>
        <p class="sub">${esc(d.term.name)}　开课 ${d.offeringCount} 门，学生 ${d.studentCount} 人</p>
      </div>
      <div class="head-actions">
        <button class="btn" id="go-offerings">开课计划</button>
        <button class="btn btn-primary" id="go-quota">名额管理</button>
      </div>
    </div>

    <div class="stat-grid mb-16">
      <div class="stat"><div class="label">开课门数</div><div class="value">${d.offeringCount}<small>门</small></div><div class="hint">本学期有效开课</div></div>
      <div class="stat"><div class="label">选课记录</div><div class="value">${d.enrollCount}<small>条</small></div><div class="hint">状态为「已选」的记录</div></div>
      <div class="stat"><div class="label">容量利用率</div><div class="value">${d.utilization}<small>%</small></div><div class="hint">已选 ${d.totalEnrolled} / 容量 ${d.totalCapacity}</div></div>
      <div class="stat"><div class="label">候补人数</div><div class="value">${d.waitCount}<small>人</small></div><div class="hint">正在排队等待递补</div></div>
      <div class="stat"><div class="label">已满开课</div><div class="value">${d.fullCount}<small>门</small></div><div class="hint">已选达到容量上限</div></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>热门开课 TOP 8</h3><div class="head-actions"><span class="small muted">按利用率排序</span></div></div>
        <div class="card-body tight">
          ${
            d.hotCourses.length
              ? `<div class="table-wrap"><table class="data">
                  <thead><tr><th>课程</th><th class="num">已选/容量</th><th class="num">利用率</th><th>热度</th></tr></thead>
                  <tbody>${d.hotCourses
                    .map(
                      (c) => `<tr>
                      <td><div class="course-name">${esc(c.course_name)}<span class="course-code">${esc(c.course_code)}</span></div></td>
                      <td class="num">${c.enrolled} / ${c.capacity}</td>
                      <td class="num">${c.rate}%</td>
                      <td><span class="badge ${
                        c.rate >= 90 ? 'badge-red' : c.rate >= 60 ? 'badge-amber' : 'badge-green'
                      }">${c.rate >= 90 ? '高' : c.rate >= 60 ? '中' : '低'}</span></td>
                    </tr>`
                    )
                    .join('')}</tbody></table></div>`
              : emptyState('暂无开课数据', '📊')
          }
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>选课批次与开放状态</h3></div>
        <div class="card-body">
          <div class="timeline">
            ${d.batches
              .map((b) => {
                const now = Date.now();
                const start = new Date(b.start_time).getTime();
                const end = new Date(b.end_time).getTime();
                const state = now < start ? '未开始' : now > end ? '已结束' : '进行中';
                const cls = state === '进行中' ? 'badge-green' : state === '未开始' ? 'badge-blue' : 'badge-gray';
                return `<div class="tl-item">
                  <div class="dot-wrap"><span class="dot"></span><span class="line"></span></div>
                  <div class="tl-body">
                    <div class="tl-title">${esc(b.name)} <span class="badge ${cls}">${state}</span></div>
                    <div class="tl-time">${fmtTime(b.start_time)} ~ ${fmtTime(b.end_time)}</div>
                    <div class="tl-text">目标：${esc(b.target_grade || '不限年级')} / ${esc(b.target_college || '不限学院')}　优先级 ${b.priority}</div>
                  </div>
                </div>`;
              })
              .join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  $('#go-offerings').onclick = () => ctx.go('a/offerings');
  $('#go-quota').onclick = () => ctx.go('a/quota');
}

/* ---------------- 课程目录 ---------------- */

export async function renderCourses(root, ctx) {
  let keyword = '';
  let categoryId = '';

  const paint = async () => {
    const box = $('#course-box');
    box.innerHTML = loadingState();
    const d = await api.get('/api/admin/courses', { keyword, categoryId, size: 50 });

    box.innerHTML = `
      ${d.list.length
        ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>课程代码</th><th>课程名称</th><th>类别</th><th class="num">学分</th><th>开课单位</th><th class="num">开课数</th><th class="num">先修数</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${d.list
            .map(
              (c) => `<tr>
              <td>${esc(c.course_code)}</td>
              <td class="course-name">${esc(c.name)}</td>
              <td>${esc(c.category_name)}</td>
              <td class="num">${c.credit}</td>
              <td>${esc(c.dept || '—')}</td>
              <td class="num">${c.offering_count}</td>
              <td class="num">${c.prereq_count}</td>
              <td>${c.status === 1 ? '<span class="badge badge-green">启用</span>' : '<span class="badge badge-gray">停用</span>'}</td>
              <td><div class="row-actions">
                <button class="btn btn-sm" data-edit="${c.id}">编辑</button>
                <button class="btn btn-sm" data-prereq="${c.id}" data-name="${esc(c.name)}">先修</button>
                <button class="btn btn-sm btn-danger" data-del="${c.id}" data-name="${esc(c.name)}">删除</button>
              </div></td>
            </tr>`
            )
            .join('')}</tbody></table></div>`
        : emptyState('没有匹配的课程', '📚')}
      <div class="pager"><span class="page-info">共 ${d.total} 门课程</span></div>
    `;

    $$('[data-edit]', box).forEach((b) => {
      b.onclick = () => openCourseForm(ctx, d.list.find((c) => c.id === Number(b.dataset.edit)), paint);
    });
    $$('[data-prereq]', box).forEach((b) => {
      b.onclick = () => openPrereqForm(ctx, Number(b.dataset.prereq), b.dataset.name, paint);
    });
    $$('[data-del]', box).forEach((b) => {
      b.onclick = async () => {
        const ok = await confirmDialog({
          title: '删除课程',
          text: `确认删除课程《${b.dataset.name}》？`,
          detail: '仅当该课程没有任何开课记录时才可删除；已有开课的课程请改为「停用」。',
          confirmText: '确认删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.del(`/api/admin/courses/${b.dataset.del}`);
          toast('课程已删除', 'success');
          await paint();
        } catch (e) {
          toast('删除失败', 'error', e.message);
        }
      };
    });

  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>课程目录</h2><p class="sub">维护课程代码、名称、类别、学分与先修关系</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="btn-new">新增课程</button></div>
    </div>
    <div class="card">
      <div class="toolbar">
        <div class="field-inline grow">
          <span>课程名称 / 代码</span>
          <input type="text" id="c-keyword" placeholder="输入关键字搜索" />
        </div>
        <div class="field-inline" style="min-width:150px">
          <span>课程类别</span>
          <select id="c-category"><option value="">全部类别</option>
            ${ctx.state.filters.categories.map((c) => `<option value="${c.value}">${esc(c.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="card-body tight" id="course-box"></div>
    </div>
  `;

  $('#c-keyword').oninput = (e) => {
    keyword = e.target.value.trim();
    clearTimeout(window.__ct);
    window.__ct = setTimeout(paint, 320);
  };
  $('#c-category').onchange = (e) => {
    categoryId = e.target.value;
    paint();
  };
  $('#btn-new').onclick = () => openCourseForm(ctx, null, paint);

  await paint();
}

function openCourseForm(ctx, course, after) {
  const cats = ctx.state.filters.categories;
  const isEdit = !!course;
  const m = openModal({
    title: isEdit ? `编辑课程：${course.name}` : '新增课程',
    body: `
      <div class="form-row">
        <label class="field-inline"><span>课程代码 *</span>
          <input type="text" id="fc-code" value="${esc(course ? course.course_code : '')}" placeholder="如 CS2001" ${isEdit ? 'disabled' : ''} />
        </label>
        <label class="field-inline"><span>课程名称 *</span>
          <input type="text" id="fc-name" value="${esc(course ? course.name : '')}" placeholder="如 数据结构" />
        </label>
      </div>
      <div class="form-row mt-12">
        <label class="field-inline"><span>课程类别 *</span>
          <select id="fc-category">
            ${cats.map((c) => `<option value="${c.value}" ${course && Number(course.category_id) === c.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
        </label>
        <label class="field-inline"><span>学分 *</span>
          <input type="number" id="fc-credit" step="0.5" min="0.5" max="10" value="${course ? course.credit : 3}" />
        </label>
        <label class="field-inline"><span>开课单位</span>
          <input type="text" id="fc-dept" value="${esc(course ? course.dept || '' : '')}" placeholder="如 计算机学院" />
        </label>
        ${isEdit ? `<label class="field-inline"><span>状态</span>
          <select id="fc-status">
            <option value="1" ${course.status === 1 ? 'selected' : ''}>启用</option>
            <option value="0" ${course.status === 0 ? 'selected' : ''}>停用</option>
          </select></label>` : ''}
      </div>
      <label class="field-inline mt-12"><span>课程简介</span>
        <textarea id="fc-desc" placeholder="简要说明课程内容">${esc(course ? course.description || '' : '')}</textarea>
      </label>
    `,
    footer: `<button class="btn" data-close-x>取消</button><button class="btn btn-primary" id="fc-save">保存</button>`,
  });

  m.footer.querySelector('[data-close-x]').onclick = () => m.close();
  m.footer.querySelector('#fc-save').onclick = async () => {
    const body = {
      courseCode: m.body.querySelector('#fc-code').value.trim(),
      name: m.body.querySelector('#fc-name').value.trim(),
      categoryId: Number(m.body.querySelector('#fc-category').value),
      credit: Number(m.body.querySelector('#fc-credit').value),
      dept: m.body.querySelector('#fc-dept').value.trim(),
      description: m.body.querySelector('#fc-desc').value.trim(),
    };
    if (isEdit) {
      body.status = Number(m.body.querySelector('#fc-status').value);
      delete body.courseCode;
    }
    if (!body.name || !body.credit) {
      toast('请填写必填项', 'error');
      return;
    }
    try {
      if (isEdit) await api.put(`/api/admin/courses/${course.id}`, body);
      else await api.post('/api/admin/courses', body);
      toast(isEdit ? '课程已更新' : '课程已创建', 'success');
      m.close();
      await after();
    } catch (e) {
      toast('保存失败', 'error', e.message);
    }
  };
}

async function openPrereqForm(ctx, courseId, courseName, after) {
  const m = openModal({ title: `先修关系：${courseName}`, wide: true, body: loadingState(), footer: '' });

  try {
    const [cur, all] = await Promise.all([
      api.get(`/api/admin/courses/${courseId}/prereq`),
      api.get('/api/admin/courses', { size: 100 }),
    ]);
    const options = all.list.filter((c) => c.id !== courseId);

    const rowsHtml = (list) =>
      list
        .map(
          (p) => `<tr>
          <td>
            <select data-k="prereqCourseId">
              ${options
                .map(
                  (c) =>
                    `<option value="${c.id}" ${
                      Number(p.prereqCourseId || p.prereq_course_id) === c.id ? 'selected' : ''
                    }>${esc(c.course_code)} ${esc(c.name)}</option>`
                )
                .join('')}
            </select>
          </td>
          <td>
            <select data-k="requireType">
              <option value="1" ${Number(p.requireType || p.require_type) === 1 ? 'selected' : ''}>与（需全部满足）</option>
              <option value="2" ${Number(p.requireType || p.require_type) === 2 ? 'selected' : ''}>或（满足其一）</option>
            </select>
          </td>
          <td><input type="number" data-k="groupNo" min="1" value="${Number(p.groupNo || p.group_no || 1)}" /></td>
          <td><button type="button" class="btn btn-sm btn-ghost" data-remove>删除</button></td>
        </tr>`
        )
        .join('');

    m.body.innerHTML = `
      <div class="alert alert-info"><span class="a-ic">i</span><span>
        先修支持「与」（该条必须通过）与「或」（同一分组号内满足其一即可）两种关系；
        学生选课时将依据成绩表中标记为「已通过」的记录判定。</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>先修课程</th><th>关系类型</th><th>分组号</th><th></th></tr></thead>
        <tbody data-rows>${rowsHtml(cur.list)}</tbody>
      </table></div>
      <button type="button" class="btn btn-sm mt-8" data-add>+ 添加先修课程</button>
    `;

    const tbody = m.body.querySelector('[data-rows]');
    const newRow = () =>
      `<tr>
        <td><select data-k="prereqCourseId">${options
          .map((c) => `<option value="${c.id}">${esc(c.course_code)} ${esc(c.name)}</option>`)
          .join('')}</select></td>
        <td><select data-k="requireType"><option value="1">与（需全部满足）</option><option value="2">或（满足其一）</option></select></td>
        <td><input type="number" data-k="groupNo" min="1" value="1" /></td>
        <td><button type="button" class="btn btn-sm btn-ghost" data-remove>删除</button></td>
      </tr>`;

    function bindRemove() {
      m.body.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = () => b.closest('tr').remove();
      });
    }
    bindRemove();
    m.body.querySelector('[data-add]').onclick = () => {
      tbody.insertAdjacentHTML('beforeend', newRow());
      bindRemove();
    };

    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px';
    foot.innerHTML = `<button class="btn" data-close-x>取消</button><button class="btn btn-primary" id="pq-save">保存</button>`;
    m.mask.querySelector('.modal-foot').innerHTML = '';
    m.mask.querySelector('.modal-foot').appendChild(foot);

    foot.querySelector('[data-close-x]').onclick = () => m.close();
    foot.querySelector('#pq-save').onclick = async () => {
      const prereq = Array.from(tbody.querySelectorAll('tr')).map((tr) => ({
        prereqCourseId: Number(tr.querySelector('[data-k="prereqCourseId"]').value),
        requireType: Number(tr.querySelector('[data-k="requireType"]').value),
        groupNo: Number(tr.querySelector('[data-k="groupNo"]').value) || 1,
      }));
      try {
        await api.post(`/api/admin/courses/${courseId}/prereq`, { prereq });
        toast('先修关系已保存', 'success');
        m.close();
        await after();
      } catch (e) {
        toast('保存失败', 'error', e.message);
      }
    };
  } catch (e) {
    m.body.innerHTML = `<div class="alert alert-error"><span class="a-ic">✕</span><span>${esc(e.message)}</span></div>`;
  }
}

/* ---------------- 开课计划 ---------------- */

export async function renderOfferings(root, ctx) {
  const paint = async () => {
    const box = $('#offering-box');
    box.innerHTML = loadingState();
    const d = await api.get('/api/admin/offerings');

    box.innerHTML = `
      ${d.list.length
        ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>课程</th><th>教师</th><th>排课</th><th class="num">已选/容量</th><th class="num">候补</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${d.list
            .map(
              (o) => `<tr>
              <td><div class="course-name">${esc(o.course_name)}<span class="course-code">${esc(o.course_code)}</span></div>
                  <div class="cell-sub">${esc(o.category_name)} · ${o.credit} 学分 · ${esc(o.campus || '—')}</div></td>
              <td>${esc(o.teacher_name)}</td>
              <td>${(o.scheduleText || []).map((s) => esc(s)).join('<br>') || '<span class="muted">未排课</span>'}</td>
              <td class="num">${o.enrolled} / ${o.capacity}</td>
              <td class="num">${o.waitlistCount}</td>
              <td>${
                o.status === 0 ? '<span class="badge badge-red">停开</span>' : o.status === 2 ? '<span class="badge badge-gray">已满</span>' : '<span class="badge badge-green">开放</span>'
              }</td>
              <td><div class="row-actions"><button class="btn btn-sm" data-edit="${o.offering_id}">编辑</button></div></td>
            </tr>`
            )
            .join('')}</tbody></table></div>`
        : emptyState('本学期暂无开课记录', '🗂')}
      <div class="pager"><span class="page-info">共 ${d.list.length} 条开课</span></div>
    `;

    $$('[data-edit]', box).forEach((b) => {
      b.onclick = () => openOfferingForm(d, d.list.find((o) => o.offering_id === Number(b.dataset.edit)), paint);
    });

    return d;
  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>开课计划</h2><p class="sub">为课程创建学期开课记录，设置容量、校区与排课时段</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="btn-new-offering">新增开课</button></div>
    </div>
    <div class="card"><div class="card-body tight" id="offering-box"></div></div>
  `;

  const d = await paint();
  $('#btn-new-offering').onclick = () => openOfferingForm(d, null, paint);
}

function openOfferingForm(d, offering, after) {
  const isEdit = !!offering;
  const editor = scheduleEditor(offering ? offering.schedules : []);

  const m = openModal({
    title: isEdit ? `编辑开课：${offering.course_name}` : '新增开课',
    wide: true,
    body: `
      ${
        isEdit
          ? ''
          : `<div class="form-row mb-12">
        <label class="field-inline"><span>课程 *</span>
          <select id="fo-course">${d.courses
            .map((c) => `<option value="${c.id}">${esc(c.course_code)} ${esc(c.name)}（${c.credit} 学分）</option>`)
            .join('')}</select>
        </label>
        <label class="field-inline"><span>授课教师 *</span>
          <select id="fo-teacher">${d.teachers
            .map((t) => `<option value="${t.id}">${esc(t.real_name)}（${esc(t.teacher_no)}）</option>`)
            .join('')}</select>
        </label>
      </div>`
      }
      <div class="form-row">
        <label class="field-inline"><span>容量上限 *</span>
          <input type="number" id="fo-capacity" min="1" max="500" value="${isEdit ? offering.capacity : 50}" />
        </label>
        <label class="field-inline"><span>校区</span>
          <input type="text" id="fo-campus" value="${esc(isEdit ? offering.campus || '' : '')}" placeholder="如 东校区" />
        </label>
        ${
          isEdit
            ? `<label class="field-inline"><span>状态</span>
          <select id="fo-status">
            <option value="1" ${offering.status === 1 ? 'selected' : ''}>开放</option>
            <option value="0" ${offering.status === 0 ? 'selected' : ''}>停开</option>
          </select></label>`
            : ''
        }
      </div>
      <label class="field-inline mt-12"><span>备注</span>
        <input type="text" id="fo-remark" value="${esc(isEdit ? offering.remark || '' : '')}" />
      </label>
      <div class="sep"></div>
      <div class="section-title">排课时段</div>
      ${editor.html}
      ${isEdit ? `<p class="small muted mt-8">已选 ${offering.enrolled} 人，容量不得小于该数值。</p>` : ''}
    `,
    footer: `<button class="btn" data-close-x>取消</button><button class="btn btn-primary" id="fo-save">保存</button>`,
    onMount: ({ body }) => editor.mount(body),
  });

  m.footer.querySelector('[data-close-x]').onclick = () => m.close();
  m.footer.querySelector('#fo-save').onclick = async () => {
    const schedules = editor.read(m.body);
    const bad = schedules.find((s) => s.startPeriod > s.endPeriod);
    if (bad) {
      toast('节次区间不合法', 'error', '起始节次不能大于结束节次');
      return;
    }
    const body = {
      capacity: Number(m.body.querySelector('#fo-capacity').value),
      campus: m.body.querySelector('#fo-campus').value.trim(),
      remark: m.body.querySelector('#fo-remark').value.trim(),
      schedules,
    };
    if (!body.capacity) {
      toast('请填写容量', 'error');
      return;
    }
    try {
      if (isEdit) {
        body.status = Number(m.body.querySelector('#fo-status').value);
        await api.put(`/api/admin/offerings/${offering.offering_id}`, body);
      } else {
        body.courseId = Number(m.body.querySelector('#fo-course').value);
        body.teacherId = Number(m.body.querySelector('#fo-teacher').value);
        await api.post('/api/admin/offerings', body);
      }
      toast(isEdit ? '开课已更新' : '开课已创建', 'success');
      m.close();
      await after();
    } catch (e) {
      toast('保存失败', 'error', e.message);
    }
  };
}

/* ---------------- 名额管理 ---------------- */

export async function renderQuota(root, ctx) {
  const paint = async () => {
    const box = $('#quota-box');
    box.innerHTML = loadingState();
    const d = await api.get('/api/admin/statistics');
    box.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>课程</th><th>教师</th><th class="num">已选</th><th class="num">容量</th><th class="num">余量</th><th class="num">利用率</th><th class="num">候补</th><th>状态</th><th>调整容量</th></tr></thead>
        <tbody>${d.list
          .map(
            (o) => `<tr>
            <td><div class="course-name">${esc(o.course_name)}<span class="course-code">${esc(o.course_code)}</span></div></td>
            <td>${esc(o.teacher_name)}</td>
            <td class="num">${o.enrolled}</td>
            <td class="num">${o.capacity}</td>
            <td class="num">${Math.max(0, o.capacity - o.enrolled)}</td>
            <td class="num">${o.rate}%</td>
            <td class="num">${o.waitlist_count}</td>
            <td>${o.status === 0 ? '<span class="badge badge-red">停开</span>' : o.status === 2 ? '<span class="badge badge-gray">已满</span>' : '<span class="badge badge-green">开放</span>'}</td>
            <td>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" min="${o.enrolled}" value="${o.capacity}" data-cap="${o.offering_id}" style="width:82px" />
                <button class="btn btn-sm" data-save="${o.offering_id}" data-name="${esc(o.course_name)}">保存</button>
              </div>
            </td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>
      <div class="pager"><span class="page-info">共 ${d.list.length} 条开课；容量调整将写入审计日志，扩大容量后系统会自动触发候补递补</span></div>
    `;

    $$('[data-save]', box).forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.dataset.save);
        const input = box.querySelector(`[data-cap="${id}"]`);
        const capacity = Number(input.value);
        const cur = d.list.find((x) => x.offering_id === id);
        if (capacity === cur.capacity) {
          toast('容量未变化', 'info');
          return;
        }
        const ok = await confirmDialog({
          title: '调整容量',
          text: `将《${b.dataset.name}》的容量由 ${cur.capacity} 调整为 ${capacity}？`,
          detail: `当前已选 ${cur.enrolled} 人，候补 ${cur.waitlist_count} 人。${capacity > cur.enrolled ? '容量扩大后系统将自动触发候补递补。' : ''}`,
          confirmText: '确认调整',
        });
        if (!ok) return;
        try {
          const r = await api.put(`/api/admin/offerings/${id}`, { capacity });
          const promoted = r.promoted && r.promoted.length ? `，已递补 ${r.promoted.length} 人` : '';
          toast('容量已调整', 'success', `已写入审计日志${promoted}`);
          await paint();
        } catch (e) {
          toast('调整失败', 'error', e.message);
        }
      };
    });
  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>名额管理</h2><p class="sub">查看各开课的已选与候补人数，特殊情况下可人工调整容量（写入审计日志）</p></div>
    </div>
    <div class="card"><div class="card-body tight" id="quota-box"></div></div>
  `;
  await paint();
}

/* ---------------- 选课批次 ---------------- */

export async function renderBatches(root, ctx) {
  const paint = async () => {
    const box = $('#batch-box');
    box.innerHTML = loadingState();
    const d = await api.get('/api/admin/batches');
    box.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>批次名称</th><th>类型</th><th>起止时间</th><th>目标年级 / 学院</th><th class="num">优先级</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${d.list
          .map(
            (b) => `<tr>
            <td class="course-name">${esc(b.name)}</td>
            <td>${esc(b.typeText)}</td>
            <td>${fmtTime(b.start_time)}<br>${fmtTime(b.end_time)}</td>
            <td>${esc(b.target_grade || '不限年级')} / ${esc(b.target_college || '不限学院')}</td>
            <td class="num">${b.priority}</td>
            <td><span class="badge ${
              b.state === '进行中' ? 'badge-green' : b.state === '未开始' ? 'badge-blue' : 'badge-gray'
            }">${b.state}</span></td>
            <td><div class="row-actions">
              <button class="btn btn-sm" data-edit="${b.id}">编辑</button>
              <button class="btn btn-sm btn-danger" data-del="${b.id}" data-name="${esc(b.name)}">删除</button>
            </div></td>
          </tr>`
          )
          .join('')}</tbody></table></div>
      <div class="pager"><span class="page-info">共 ${d.list.length} 个批次；同一学生命中多个批次时取优先级数值最小者</span></div>
    `;

    $$('[data-edit]', box).forEach((b) => {
      b.onclick = () => openBatchForm(d.list.find((x) => x.id === Number(b.dataset.edit)), paint);
    });
    $$('[data-del]', box).forEach((b) => {
      b.onclick = async () => {
        const ok = await confirmDialog({
          title: '删除批次',
          text: `确认删除批次「${b.dataset.name}」？`,
          detail: '删除后该时间段内学生将无法选课，请谨慎操作。',
          confirmText: '确认删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.del(`/api/admin/batches/${b.dataset.del}`);
          toast('批次已删除', 'success');
          await paint();
        } catch (e) {
          toast('删除失败', 'error', e.message);
        }
      };
    });
  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>选课批次</h2><p class="sub">配置批次名称、类型、起止时间、目标人群与优先级，实现错峰分流</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="btn-new-batch">新增批次</button></div>
    </div>
    <div class="card"><div class="card-body tight" id="batch-box"></div></div>
  `;
  $('#btn-new-batch').onclick = () => openBatchForm(null, paint);
  await paint();
}

function openBatchForm(batch, after) {
  const toLocal = (v) => (v ? String(v).replace(' ', 'T').slice(0, 16) : '');
  const now = new Date();
  const plus = (h) => new Date(now.getTime() + h * 3600 * 1000).toISOString().slice(0, 16);

  const m = openModal({
    title: batch ? `编辑批次：${batch.name}` : '新增选课批次',
    body: `
      <div class="form-row">
        <label class="field-inline"><span>批次名称 *</span>
          <input type="text" id="fb-name" value="${esc(batch ? batch.name : '')}" placeholder="如 2024 级正常选课批次" />
        </label>
        <label class="field-inline"><span>批次类型 *</span>
          <select id="fb-type">
            <option value="1" ${batch && batch.type === 1 ? 'selected' : ''}>正常选课</option>
            <option value="2" ${batch && batch.type === 2 ? 'selected' : ''}>补退选</option>
          </select>
        </label>
      </div>
      <div class="form-row mt-12">
        <label class="field-inline"><span>开始时间 *</span>
          <input type="datetime-local" id="fb-start" value="${batch ? toLocal(batch.start_time) : plus(0)}" />
        </label>
        <label class="field-inline"><span>截止时间 *</span>
          <input type="datetime-local" id="fb-end" value="${batch ? toLocal(batch.end_time) : plus(24 * 14)}" />
        </label>
      </div>
      <div class="form-row mt-12">
        <label class="field-inline"><span>目标年级（逗号分隔，留空不限）</span>
          <input type="text" id="fb-grade" value="${esc(batch ? batch.target_grade || '' : '')}" placeholder="如 2024,2025" />
        </label>
        <label class="field-inline"><span>目标学院（留空不限）</span>
          <input type="text" id="fb-college" value="${esc(batch ? batch.target_college || '' : '')}" placeholder="如 计算机学院" />
        </label>
        <label class="field-inline"><span>优先级（数值越小越优先）</span>
          <input type="number" id="fb-priority" value="${batch ? batch.priority : 1}" />
        </label>
      </div>
      <div class="alert alert-info mt-16"><span class="a-ic">i</span><span>
        提示：一名学生在同一学期可能命中多个批次，系统取其优先级最高且处于时间窗口内的批次作为有效批次。</span></div>
    `,
    footer: `<button class="btn" data-close-x>取消</button><button class="btn btn-primary" id="fb-save">保存</button>`,
  });

  m.footer.querySelector('[data-close-x]').onclick = () => m.close();
  m.footer.querySelector('#fb-save').onclick = async () => {
    const body = {
      name: m.body.querySelector('#fb-name').value.trim(),
      type: Number(m.body.querySelector('#fb-type').value),
      startTime: m.body.querySelector('#fb-start').value,
      endTime: m.body.querySelector('#fb-end').value,
      targetGrade: m.body.querySelector('#fb-grade').value.trim(),
      targetCollege: m.body.querySelector('#fb-college').value.trim(),
      priority: Number(m.body.querySelector('#fb-priority').value) || 0,
    };
    if (!body.name || !body.startTime || !body.endTime) {
      toast('请填写批次名称与起止时间', 'error');
      return;
    }
    if (new Date(body.startTime) >= new Date(body.endTime)) {
      toast('时间不合法', 'error', '开始时间必须早于截止时间');
      return;
    }
    try {
      if (batch) await api.put(`/api/admin/batches/${batch.id}`, body);
      else await api.post('/api/admin/batches', body);
      toast(batch ? '批次已更新' : '批次已创建', 'success');
      m.close();
      await after();
    } catch (e) {
      toast('保存失败', 'error', e.message);
    }
  };
}

/* ---------------- 学分规则 ---------------- */

export async function renderCredits(root, ctx) {
  const paint = async () => {
    const box = $('#credit-box');
    box.innerHTML = loadingState();
    const d = await api.get('/api/admin/credit-rules');
    box.innerHTML = `
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>学期学分上下限</h3><div class="head-actions"><span class="small muted">上限拦截，下限仅预警</span></div></div>
          <div class="card-body tight">
            <div class="table-wrap"><table class="data">
              <thead><tr><th>年级</th><th class="num">下限（预警）</th><th class="num">上限（拦截）</th><th>操作</th></tr></thead>
              <tbody>${d.gradeRules
                .map(
                  (g) => `<tr>
                  <td>${esc(g.grade)} 级</td>
                  <td class="num"><input type="number" step="0.5" value="${g.min_credit}" data-min="${g.grade}" style="width:90px" /></td>
                  <td class="num"><input type="number" step="0.5" value="${g.max_credit}" data-max="${g.grade}" style="width:90px" /></td>
                  <td><button class="btn btn-sm" data-save-grade="${g.grade}">保存</button></td>
                </tr>`
                )
                .join('')}</tbody>
            </table></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>类别学分要求</h3></div>
          <div class="card-body tight">
            <div class="table-wrap"><table class="data">
              <thead><tr><th>课程类别</th><th class="num">最低学分</th><th class="num">最高学分</th><th>操作</th></tr></thead>
              <tbody>${d.categories
                .map((c) => {
                  const r = d.categoryRules.find((x) => x.category_id === c.id) || {};
                  return `<tr>
                    <td>${esc(c.name)}</td>
                    <td class="num"><input type="number" step="0.5" value="${r.min_credit === null || r.min_credit === undefined ? '' : r.min_credit}" data-cmin="${c.id}" style="width:90px" /></td>
                    <td class="num"><input type="number" step="0.5" value="${r.max_credit === null || r.max_credit === undefined ? '' : r.max_credit}" data-cmax="${c.id}" style="width:90px" /></td>
                    <td><button class="btn btn-sm" data-save-cat="${c.id}">保存</button></td>
                  </tr>`;
                })
                .join('')}</tbody>
            </table></div>
          </div>
        </div>
      </div>
    `;

    $$('[data-save-grade]', box).forEach((b) => {
      b.onclick = async () => {
        const grade = b.dataset.saveGrade;
        try {
          await api.post('/api/admin/credit-rules', {
            grade,
            minCredit: Number(box.querySelector(`[data-min="${grade}"]`).value) || 0,
            maxCredit: Number(box.querySelector(`[data-max="${grade}"]`).value),
          });
          toast(`${grade} 级学分规则已保存`, 'success');
          await paint();
        } catch (e) {
          toast('保存失败', 'error', e.message);
        }
      };
    });

    $$('[data-save-cat]', box).forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.saveCat;
        try {
          await api.post('/api/admin/category-credit-rules', {
            categoryId: Number(id),
            minCredit: box.querySelector(`[data-cmin="${id}"]`).value,
            maxCredit: box.querySelector(`[data-cmax="${id}"]`).value,
          });
          toast('类别学分要求已保存', 'success');
          await paint();
        } catch (e) {
          toast('保存失败', 'error', e.message);
        }
      };
    });
  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>学分规则</h2><p class="sub">配置各年级本学期的学分上下限与各类别的学分要求</p></div>
    </div>
    <div id="credit-box"></div>
  `;
  await paint();
}

/* ---------------- 公告发布 ---------------- */

export async function renderAnnouncements(root, ctx) {
  const paint = async () => {
    const box = $('#ann-box');
    box.innerHTML = loadingState();
    const d = await api.get('/api/admin/announcements');
    box.innerHTML = `
      ${
        d.list.length
          ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>标题</th><th>发布人</th><th>发布时间</th><th>范围</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>${d.list
                .map(
                  (a) => `<tr>
                  <td><div class="course-name">${esc(a.title)}</div><div class="cell-sub">${esc(
                    String(a.content).slice(0, 60)
                  )}…</div></td>
                  <td>${esc(a.publisher_name)}</td>
                  <td>${fmtTime(a.publish_time)}</td>
                  <td>${esc(a.target_scope || '全体')}</td>
                  <td>${
                    a.status === 1 ? '<span class="badge badge-green">已发布</span>' : a.status === 0 ? '<span class="badge badge-gray">草稿</span>' : '<span class="badge badge-red">已下架</span>'
                  }</td>
                  <td><div class="row-actions">
                    ${
                      a.status === 1
                        ? `<button class="btn btn-sm" data-status="${a.id}" data-s="2">下架</button>`
                        : `<button class="btn btn-sm" data-status="${a.id}" data-s="1">发布</button>`
                    }
                  </div></td>
                </tr>`
                )
                .join('')}</tbody>
            </table></div>`
          : emptyState('暂无公告', '📢')
      }`;
    $$('[data-status]', box).forEach((b) => {
      b.onclick = async () => {
        try {
          await api.put(`/api/admin/announcements/${b.dataset.status}/status`, { status: Number(b.dataset.s) });
          toast('公告状态已更新', 'success');
          await paint();
        } catch (e) {
          toast('操作失败', 'error', e.message);
        }
      };
    });
  };

  root.innerHTML = `
    <div class="page-head">
      <div><h2>公告发布</h2><p class="sub">发布选课时间与规则公告，并向指定范围投递站内通知</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="btn-new-ann">发布公告</button></div>
    </div>
    <div class="card"><div class="card-body tight" id="ann-box"></div></div>
  `;

  $('#btn-new-ann').onclick = () => {
    const m = openModal({
      title: '发布公告',
      wide: true,
      body: `
        <label class="field-inline mb-12"><span>公告标题 *</span>
          <input type="text" id="an-title" placeholder="如 2026-2027 学年第一学期选课通知" />
        </label>
        <div class="form-row mb-12">
          <label class="field-inline"><span>投递范围（留空为全体学生）</span>
            <input type="text" id="an-scope" placeholder="如 2024 级" />
          </label>
          <label class="field-inline"><span>仅投递给指定年级</span>
            <select id="an-grade">
              <option value="">全体学生</option>
              <option value="2023">2023 级</option>
              <option value="2024">2024 级</option>
              <option value="2025">2025 级</option>
            </select>
          </label>
        </div>
        <label class="field-inline"><span>公告正文 *</span>
          <textarea id="an-content" rows="7" placeholder="请填写公告正文"></textarea>
        </label>
        <div class="alert alert-info mt-16"><span class="a-ic">i</span><span>发布后系统将向目标范围内的学生投递站内通知；也可保存为草稿稍后发布。</span></div>
      `,
      footer: `<button class="btn" data-close-x>取消</button>
               <button class="btn" id="an-draft">存为草稿</button>
               <button class="btn btn-primary" id="an-publish">发布并投递</button>`,
    });

    const submit = async (publish) => {
      const title = m.body.querySelector('#an-title').value.trim();
      const content = m.body.querySelector('#an-content').value.trim();
      if (!title || !content) {
        toast('请填写标题与正文', 'error');
        return;
      }
      try {
        await api.post('/api/admin/announcements', {
          title,
          content,
          targetScope: m.body.querySelector('#an-scope').value.trim(),
          targetGrade: m.body.querySelector('#an-grade').value,
          publish,
        });
        toast(publish ? '公告已发布并投递通知' : '已保存为草稿', 'success');
        m.close();
        await paint();
      } catch (e) {
        toast('操作失败', 'error', e.message);
      }
    };

    m.footer.querySelector('[data-close-x]').onclick = () => m.close();
    m.footer.querySelector('#an-draft').onclick = () => submit(false);
    m.footer.querySelector('#an-publish').onclick = () => submit(true);
  };

  await paint();
}
