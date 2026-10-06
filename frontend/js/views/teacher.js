/**
 * 教师端页面（见设计文档 3.3）。
 * 教师可维护本人开课的上课时间与地点；容量由教务设定，教师不可修改。
 */

import { api } from '../api.js';
import { $, $$, esc, toast, openModal, emptyState, loadingState } from '../ui.js';
import { scheduleEditor } from '../scheduleEditor.js';

export async function renderOfferings(root, ctx) {
  root.innerHTML = loadingState('正在加载开课列表…');
  const d = await api.get('/api/teacher/offerings');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2>我的开课</h2>
        <p class="sub">${esc(d.term.name)}　共 ${d.list.length} 门开课；容量由教务管理员设定，教师可维护上课时间与地点</p>
      </div>
      <div class="head-actions">
        <button class="btn" id="btn-students">查看选课名单</button>
      </div>
    </div>

    <div class="card">
      <div class="card-body tight">
        ${
          d.list.length
            ? `<div class="table-wrap"><table class="data">
            <thead><tr>
              <th>课程</th><th>上课时间与地点</th><th class="num">已选/容量</th><th>热度</th><th class="num">候补</th><th>状态</th><th>操作</th>
            </tr></thead>
            <tbody>${d.list
              .map(
                (o) => `<tr>
                <td>
                  <div class="course-name">${esc(o.courseName)}<span class="course-code">${esc(o.courseCode)}</span></div>
                  <div class="cell-sub">${esc(o.categoryName)} · ${o.credit} 学分 · ${esc(o.teacherName)}</div>
                </td>
                <td>${(o.scheduleText || []).map((s) => esc(s)).join('<br>') || '<span class="muted">未排课</span>'}</td>
                <td class="num">${o.enrolled} / ${o.capacity}<div class="cell-sub">余 ${o.remaining}</div></td>
                <td><span class="badge ${o.heat === '高' ? 'badge-red' : o.heat === '中' ? 'badge-amber' : 'badge-green'}">${esc(o.heat)}</span></td>
                <td class="num">${o.waitlistCount}</td>
                <td>${
                  o.status === 0
                    ? '<span class="badge badge-red">停开</span>'
                    : o.status === 2
                    ? '<span class="badge badge-gray">已满</span>'
                    : '<span class="badge badge-green">开放</span>'
                }</td>
                <td>
                  <div class="row-actions">
                    <button class="btn btn-sm" data-edit="${o.offeringId}">维护排课</button>
                    <button class="btn btn-sm btn-ghost" data-list="${o.offeringId}">名单</button>
                  </div>
                </td>
              </tr>`
              )
              .join('')}</tbody></table></div>`
            : emptyState('本学期暂无开课记录', '📖')
        }
      </div>
    </div>
  `;

  $('#btn-students').onclick = () => ctx.go('t/students');

  $$('[data-edit]', root).forEach((b) => {
    b.onclick = () => openScheduleEditor(ctx, Number(b.dataset.edit), d.list);
  });
  $$('[data-list]', root).forEach((b) => {
    b.onclick = () => openStudentList(Number(b.dataset.list));
  });
}

function openScheduleEditor(ctx, offeringId, list) {
  const item = list.find((x) => x.offeringId === offeringId);
  const editor = scheduleEditor(item.schedules || []);

  const m = openModal({
    title: `维护排课：${item.courseName}`,
    wide: true,
    body: `
      <div class="alert alert-info"><span class="a-ic">i</span><span>
        教师可维护上课时间与地点；容量由教务管理员设定，此处不可修改。
        保存后系统将按新的时段参与学生选课的时间冲突检测。</span></div>
      <div class="field-inline mb-12">
        <span>备注</span>
        <input type="text" id="of-remark" value="${esc(item.remark || '')}" placeholder="如：需要上机实验" />
      </div>
      ${editor.html}
    `,
    footer: `<button class="btn" data-close-x>取消</button><button class="btn btn-primary" id="btn-save-schedule">保存</button>`,
    onMount: ({ body }) => editor.mount(body),
  });

  m.footer.querySelector('[data-close-x]').onclick = () => m.close();
  m.footer.querySelector('#btn-save-schedule').onclick = async () => {
    const schedules = editor.read(m.body);
    const bad = schedules.find((s) => s.startPeriod > s.endPeriod);
    if (bad) {
      toast('节次区间不合法', 'error', '起始节次不能大于结束节次');
      return;
    }
    const btn = m.footer.querySelector('#btn-save-schedule');
    btn.disabled = true;
    try {
      await api.put(`/api/teacher/offerings/${offeringId}`, {
        schedules,
        remark: m.body.querySelector('#of-remark').value.trim(),
      });
      toast('排课已保存', 'success', `共 ${schedules.length} 个时段`);
      m.close();
      await ctx.reload();
    } catch (e) {
      toast('保存失败', 'error', e.message);
    } finally {
      btn.disabled = false;
    }
  };
}

async function openStudentList(offeringId) {
  const m = openModal({ title: '选课名单', wide: true, body: loadingState(), footer: null });
  try {
    const d = await api.get(`/api/teacher/offerings/${offeringId}/students`);
    m.body.innerHTML = `
      <div class="alert alert-info"><span class="a-ic">i</span><span>已选 ${d.enrolled} 人 / 容量 ${d.capacity} 人；候补 ${d.waitlist.length} 人。</span></div>
      <div class="section-title">已选学生名单</div>
      ${
        d.students.length
          ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>学号</th><th>姓名</th><th>年级</th><th>学院 / 专业</th><th>选课时间</th><th>来源</th></tr></thead>
              <tbody>${d.students
                .map(
                  (s) => `<tr>
                  <td>${esc(s.student_no)}</td><td>${esc(s.real_name)}</td><td>${esc(s.grade)}</td>
                  <td>${esc(s.college)}${s.major ? ' / ' + esc(s.major) : ''}</td>
                  <td>${esc(String(s.select_time).replace('T', ' ').slice(0, 16))}</td>
                  <td>${esc(s.source_text)}</td></tr>`
                )
                .join('')}</tbody></table></div>`
          : emptyState('暂无学生选课', '👥')
      }
      <div class="sep"></div>
      <div class="section-title">候补队列</div>
      ${
        d.waitlist.length
          ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>排位</th><th>学号</th><th>姓名</th><th>加入时间</th><th>状态</th></tr></thead>
              <tbody>${d.waitlist
                .map(
                  (w) => `<tr><td>第 ${w.queue_no} 位</td><td>${esc(w.student_no)}</td><td>${esc(w.real_name)}</td>
                  <td>${esc(String(w.join_time).replace('T', ' ').slice(0, 16))}</td>
                  <td>${w.status === 2 ? '已递补' : '候补中'}</td></tr>`
                )
                .join('')}</tbody></table></div>`
          : '<p class="muted small">暂无候补</p>'
      }
    `;
  } catch (e) {
    m.body.innerHTML = `<div class="alert alert-error"><span class="a-ic">✕</span><span>${esc(e.message)}</span></div>`;
  }
}

export async function renderStudents(root, ctx) {
  root.innerHTML = loadingState();
  const d = await api.get('/api/teacher/offerings');

  root.innerHTML = `
    <div class="page-head">
      <div><h2>选课名单</h2><p class="sub">选择一门开课查看已选学生与候补队列</p></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3>选择开课</h3>
        <div class="head-actions">
          <div class="field-inline" style="min-width:280px">
            <select id="pick-offering">
              ${d.list
                .map(
                  (o) =>
                    `<option value="${o.offeringId}">${esc(o.courseCode)} ${esc(o.courseName)}（${o.enrolled}/${o.capacity}）</option>`
                )
                .join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="card-body tight" id="list-box"></div>
    </div>
  `;

  if (!d.list.length) {
    $('#list-box').innerHTML = emptyState('本学期暂无开课', '📖');
    return;
  }

  const load = async () => {
    const box = $('#list-box');
    box.innerHTML = loadingState();
    const id = Number($('#pick-offering').value);
    const r = await api.get(`/api/teacher/offerings/${id}/students`);
    box.innerHTML = `
      <div class="card-body">
        <div class="stat-grid">
          <div class="stat"><div class="label">已选人数</div><div class="value">${r.enrolled}<small>/ ${r.capacity}</small></div></div>
          <div class="stat"><div class="label">候补人数</div><div class="value">${r.waitlist.length}<small>人</small></div></div>
        </div>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>学号</th><th>姓名</th><th>年级</th><th>学院 / 专业</th><th>选课时间</th><th>来源</th></tr></thead>
        <tbody>${
          r.students.length
            ? r.students
                .map(
                  (s) => `<tr><td>${esc(s.student_no)}</td><td>${esc(s.real_name)}</td><td>${esc(s.grade)}</td>
              <td>${esc(s.college)}${s.major ? ' / ' + esc(s.major) : ''}</td>
              <td>${esc(String(s.select_time).replace('T', ' ').slice(0, 16))}</td>
              <td>${esc(s.source_text)}</td></tr>`
                )
                .join('')
            : `<tr><td colspan="6">${emptyState('暂无学生选课', '👥')}</td></tr>`
        }</tbody>
      </table></div>
    `;
  };

  $('#pick-offering').onchange = load;
  await load();
}
