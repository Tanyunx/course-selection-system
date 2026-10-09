/**
 * 学生端页面（见设计文档 3.2）。
 */

import { api, writeBody, ApiError } from '../api.js';
import {
  $, $$, esc, toast, openModal, confirmDialog, emptyState, loadingState,
  statusBadge, heatBadge, heatProgress, debounce, fmtTime, relativeTime,
  WEEKDAY_TEXT, PARITY_TEXT, PERIOD_TIME, PERIOD_BAND, PERIOD_GROUP, PERIOD_COUNT,
} from '../ui.js';
import { exportCsv, exportIcs } from '../exportSchedule.js';

/* ==================================================================
   通用：选课 / 候补 / 退课 操作
   ================================================================== */

export async function doEnroll(ctx, offeringId, courseName) {
  const ok = await confirmDialog({
    title: '确认选课',
    text: `确认选修《${courseName}》？系统将校验批次、容量、时间冲突、学分与先修要求。`,
    confirmText: '确认选课',
  });
  if (!ok) return false;
  try {
    const r = await api.post('/api/enrollments', writeBody({ offeringId }));
    let detail = '';
    if (r.credit && r.credit.willTotal !== undefined) {
      detail = `本学期已选 ${r.credit.willTotal} 学分`;
    }
    if (r.tightTransfers && r.tightTransfers.length) {
      detail += (detail ? '；' : '') + r.tightTransfers.map((t) => t.text).join('；');
    }
    toast('选课成功', 'success', detail);
    await ctx.refreshUnread();
    return true;
  } catch (e) {
    handleActionError(e, courseName);
    return false;
  }
}

export async function doWaitlist(ctx, offeringId, courseName) {
  const ok = await confirmDialog({
    title: '加入候补',
    text: `《${courseName}》当前名额已满，加入候补后将在名额释放时按排位自动递补。确认加入？`,
    confirmText: '加入候补',
  });
  if (!ok) return false;
  try {
    const r = await api.post('/api/waitlist', writeBody({ offeringId }));
    toast('已加入候补', 'success', `当前排位第 ${r.queueNo} 位，共 ${r.queueCount} 人候补`);
    await ctx.refreshUnread();
    return true;
  } catch (e) {
    handleActionError(e, courseName);
    return false;
  }
}

export async function doDrop(ctx, offeringId, courseName, deadline) {
  const ok = await confirmDialog({
    title: '确认退课',
    text: `确认退选《${courseName}》？`,
    detail: `退课后名额将立即释放并触发候补递补，操作不可撤销。${
      deadline ? `本学期退课截止时间：${fmtTime(deadline)}。` : ''
    }`,
    confirmText: '确认退课',
    danger: true,
  });
  if (!ok) return false;
  try {
    const data = await api.del(`/api/enrollments/${offeringId}`, writeBody({}));
    const promoted = data.promoted && data.promoted.length ? data.promoted[0] : null;
    toast(
      '退课成功',
      'success',
      promoted
        ? `名额已递补给候补第 ${promoted.queueNo} 位同学（${promoted.studentName || ''}）`
        : '名额已释放'
    );
    await ctx.refreshUnread();
    return true;
  } catch (e) {
    handleActionError(e, courseName);
    return false;
  }
}

function handleActionError(e, courseName) {
  if (!(e instanceof ApiError)) {
    toast('操作失败', 'error', e.message);
    return;
  }
  const extra = e.data || {};
  let detail = '';
  if (extra.conflicts && extra.conflicts.length) {
    detail = extra.conflicts
      .map((c) => `${WEEKDAY_TEXT[c.weekday]} ${c.start_period}-${c.end_period} 节 与《${c.course_name}》`)
      .join('；');
  } else if (extra.missing && extra.missing.length) {
    detail = '缺失先修课程：' + extra.missing.map((m) => `《${m.name}》`).join('、');
  } else if (extra.queueNo) {
    detail = `当前排位第 ${extra.queueNo} 位`;
  } else if (extra.nextBatch) {
    detail = `你的批次「${extra.nextBatch.name}」将于 ${fmtTime(extra.nextBatch.startTime)} 开放`;
  } else if (extra.deadline) {
    detail = `截止时间：${fmtTime(extra.deadline)}`;
  }
  toast(e.message || '操作失败', e.code === 9001 ? 'warn' : 'error', detail);
}

/* ==================================================================
   选课中心
   ================================================================== */

const courseFilters = { keyword: '', categoryId: '', weekday: '', campus: '', available: false, sort: 'code', page: 1, size: 10 };

export async function renderCourses(root, ctx) {
  const f = ctx.state.filters;
  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2>选课中心</h2>
        <p class="sub" id="page-sub"></p>
      </div>
      <div class="head-actions">
        <button class="btn" id="btn-rules">选课规则</button>
        <button class="btn" id="btn-my">我的已选</button>
      </div>
    </div>

    <div id="batch-alert"></div>

    <div class="card">
      <div class="toolbar">
        <div class="field-inline grow">
          <span>课程名称 / 课程代码</span>
          <input type="text" id="f-keyword" placeholder="如 数据结构 或 CS2001" value="${esc(courseFilters.keyword)}" />
        </div>
        <div class="field-inline">
          <span>课程类别</span>
          <select id="f-category">
            <option value="">全部类别</option>
            ${f.categories.map((c) => `<option value="${c.value}">${esc(c.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field-inline">
          <span>上课星期</span>
          <select id="f-weekday">
            <option value="">不限</option>
            ${f.weekdays.map((w) => `<option value="${w.value}">${esc(w.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field-inline">
          <span>上课校区</span>
          <select id="f-campus">
            <option value="">不限</option>
            ${f.campuses.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="field-inline">
          <span>排序</span>
          <select id="f-sort">
            <option value="code">按课程代码</option>
            <option value="heat">按热度</option>
            <option value="enrolled">按已选人数</option>
          </select>
        </div>
        <label class="checkbox" style="height:34px">
          <input type="checkbox" id="f-available" ${courseFilters.available ? 'checked' : ''} /> 仅看可选
        </label>
        <button class="btn" id="f-reset">重置</button>
      </div>
      <div id="course-list-wrap"></div>
    </div>
  `;

  $('#f-category').value = courseFilters.categoryId;
  $('#f-weekday').value = courseFilters.weekday;
  $('#f-campus').value = courseFilters.campus;
  $('#f-sort').value = courseFilters.sort;

  const reload = () => renderCourses(root, ctx);

  const syncAndLoad = (patch) => {
    Object.assign(courseFilters, patch, { page: patch.page || 1 });
    loadList();
  };

  $('#f-keyword').oninput = debounce((e) => syncAndLoad({ keyword: e.target.value.trim() }), 350);
  $('#f-category').onchange = (e) => syncAndLoad({ categoryId: e.target.value });
  $('#f-weekday').onchange = (e) => syncAndLoad({ weekday: e.target.value });
  $('#f-campus').onchange = (e) => syncAndLoad({ campus: e.target.value });
  $('#f-sort').onchange = (e) => syncAndLoad({ sort: e.target.value });
  $('#f-available').onchange = (e) => syncAndLoad({ available: e.target.checked });
  $('#f-reset').onclick = () => {
    Object.assign(courseFilters, { keyword: '', categoryId: '', weekday: '', campus: '', available: false, sort: 'code', page: 1 });
    reload();
  };
  $('#btn-rules').onclick = () => ctx.go('rules');
  $('#btn-my').onclick = () => ctx.go('my');

  await loadList();

  async function loadList() {
    const wrap = $('#course-list-wrap');
    wrap.innerHTML = loadingState('正在加载课程…');

    let data;
    try {
      data = await api.get('/api/courses', {
        page: courseFilters.page,
        size: courseFilters.size,
        keyword: courseFilters.keyword,
        categoryId: courseFilters.categoryId,
        weekday: courseFilters.weekday,
        campus: courseFilters.campus,
        available: courseFilters.available ? 'true' : '',
        sort: courseFilters.sort,
      });
    } catch (e) {
      wrap.innerHTML = `<div class="alert alert-error" style="margin:16px"><span class="a-ic">✕</span><span>课程加载失败：${esc(e.message)}</span></div>`;
      return;
    }

    const mine = await api.get('/api/enrollments/mine').catch(() => null);
    if (mine) {
      renderBatchAlert(mine);
      ctx.setSub(
        `本学期已选 ${mine.list.length} 门，共 ${mine.totalCredit} 学分${
          mine.creditRule ? `（上限 ${mine.creditRule.max_credit} 学分）` : ''
        }`
      );
    }

    if (!data.list.length) {
      wrap.innerHTML = emptyState('没有符合条件的开课，试试调整筛选条件', '🔍');
      return;
    }

    wrap.innerHTML = `
      <div class="course-list">
        ${data.list.map(courseCard).join('')}
      </div>
      <div class="pager">
        <span class="page-info">共 ${data.total} 条，第 ${data.page} / ${Math.max(1, Math.ceil(data.total / data.size))} 页</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-page="prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn btn-sm" data-page="next" ${
          data.page * data.size >= data.total ? 'disabled' : ''
        }>下一页</button>
      </div>`;

    $$('[data-page]', wrap).forEach((b) => {
      b.onclick = () => {
        courseFilters.page += b.dataset.page === 'next' ? 1 : -1;
        loadList();
      };
    });

    $$('[data-action]', wrap).forEach((btn) => {
      btn.onclick = async () => {
        const id = Number(btn.dataset.id);
        const name = btn.dataset.name;
        let changed = false;
        if (btn.dataset.action === 'enroll') changed = await doEnroll(ctx, id, name);
        else if (btn.dataset.action === 'waitlist') changed = await doWaitlist(ctx, id, name);
        else if (btn.dataset.action === 'drop') changed = await doDrop(ctx, id, name, mine && mine.dropDeadline);
        else if (btn.dataset.action === 'detail') return openCourseDetail(id, ctx);
        if (changed) await loadList();
      };
    });
  }

  function renderBatchAlert(mine) {
    const box = $('#batch-alert');
    if (!mine) {
      box.innerHTML = '';
      return;
    }
    if (mine.batch) {
      box.innerHTML = `<div class="alert alert-info"><span class="a-ic">i</span><span>
        当前生效批次：<strong>${esc(mine.batch.name)}</strong>，开放时间 ${fmtTime(mine.batch.start_time)} 至 ${fmtTime(
        mine.batch.end_time
      )}${mine.dropDeadline ? `；退课截止 ${fmtTime(mine.dropDeadline)}` : ''}</span></div>`;
    } else if (mine.nextBatch) {
      box.innerHTML = `<div class="alert alert-warn"><span class="a-ic">!</span><span>
        你当前不在任何选课批次时间窗口内。下一个批次「${esc(mine.nextBatch.name)}」将于 ${fmtTime(
        mine.nextBatch.start_time
      )} 开放。</span></div>`;
    } else {
      box.innerHTML = `<div class="alert alert-warn"><span class="a-ic">!</span><span>教务尚未为你的年级配置选课批次，请联系教务管理员。</span></div>`;
    }
  }
}

function courseCard(c) {
  const selected = c.status === 'SELECTED';
  const reasonHtml =
    c.reasons && c.reasons.length
      ? `<div class="cc-reasons">${c.reasons
          .map((r) => `<div class="cc-reason"><span class="ic">•</span><span>${esc(r.text)}</span></div>`)
          .join('')}</div>`
      : '';

  const actions = [];
  if (selected) {
    actions.push(`<button class="btn btn-danger btn-sm" data-action="drop" data-id="${c.offeringId}" data-name="${esc(c.courseName)}">退课</button>`);
  } else if (c.status === 'WAITLISTED') {
    actions.push(`<span class="small muted">候补中 第 ${c.myWaitlist ? c.myWaitlist.queueNo : '—'} 位</span>`);
  } else if (c.selectable) {
    actions.push(`<button class="btn btn-primary" data-action="enroll" data-id="${c.offeringId}" data-name="${esc(c.courseName)}">选课</button>`);
  } else if (c.waitlistable) {
    actions.push(`<button class="btn" data-action="waitlist" data-id="${c.offeringId}" data-name="${esc(c.courseName)}">加入候补</button>`);
  } else {
    actions.push(`<button class="btn" disabled>不可选</button>`);
  }
  actions.push(`<button class="btn btn-ghost btn-sm" data-action="detail" data-id="${c.offeringId}">详情</button>`);

  return `
    <article class="course-card ${selected ? 'is-selected' : ''} ${c.status === 'FULL' ? 'is-full' : ''}">
      <div>
        <div class="cc-title">
          <span class="name">${esc(c.courseName)}</span>
          <span class="code">${esc(c.courseCode)}</span>
          <span class="tag">${esc(c.categoryName)}</span>
          <span class="tag">${c.credit} 学分</span>
        </div>
        <div class="cc-meta">
          <span class="m">教师：${esc(c.teacherName)}${c.teacherTitle ? '（' + esc(c.teacherTitle) + '）' : ''}</span>
          <span class="m">校区：${esc(c.campus || '—')}</span>
          ${c.remark ? `<span class="m">备注：${esc(c.remark)}</span>` : ''}
        </div>
        <div class="cc-sched">
          ${(c.scheduleText || []).map((s) => `<span class="s">${esc(s)}</span>`).join('') || '<span class="s">排课待定</span>'}
        </div>
        <div class="cc-bar">
          ${heatProgress(c.enrolled, c.capacity)}
          <span class="cc-count">${c.enrolled} / ${c.capacity}（余 ${c.remaining}）</span>
          ${c.waitlistCount ? `<span class="small muted">候补 ${c.waitlistCount} 人</span>` : ''}
          ${c.willTotalCredit !== undefined ? `<span class="small muted">选后共 ${c.willTotalCredit} 学分</span>` : ''}
        </div>
        ${reasonHtml}
      </div>
      <div class="cc-side">
        <div class="badges">${statusBadge(c.status)}${heatBadge(c.heat)}</div>
        <div class="row-actions">${actions.join('')}</div>
      </div>
    </article>`;
}

async function openCourseDetail(offeringId, ctx) {
  const m = openModal({ title: '加载中…', body: loadingState(), footer: '', wide: true });
  try {
    const r = await api.get(`/api/courses/${offeringId}`);
    const o = r.offering;
    const s = r.studentState;
    const c = r.context;

    m.mask.querySelector('.modal-head h3').textContent = `${o.courseName}（${o.courseCode}）`;

    const prereqHtml = o.prereqList && o.prereqList.length
      ? o.prereqList
          .map(
            (p) => `<span class="badge ${p.passed ? 'badge-green' : 'badge-red'}">${esc(p.name)}${
              p.passed ? '（已通过）' : '（未通过）'
            }</span>`
          )
          .join(' ')
      : '<span class="muted small">无先修要求</span>';

    const queueHtml = o.waitlistQueue && o.waitlistQueue.length
      ? `<ol style="font-size:13px;line-height:2">${o.waitlistQueue
          .map((q) => `<li>第 ${q.queueNo} 位　${esc(q.name)}（${esc(q.studentNo)}）</li>`)
          .join('')}</ol>`
      : '<p class="muted small">暂无候补</p>';

    m.body.innerHTML = `
      ${s.reasons && s.reasons.length
        ? `<div class="alert alert-warn"><span class="a-ic">!</span><span>${s.reasons
            .map((x) => esc(x.text))
            .join('；')}</span></div>`
        : '<div class="alert alert-success"><span class="a-ic">✓</span><span>当前状态符合选课条件</span></div>'}

      <div class="grid-2">
        <div>
          <div class="section-title">开课信息</div>
          <dl class="desc">
            <dt>课程类别</dt><dd>${esc(o.categoryName)}</dd>
            <dt>学分</dt><dd>${o.credit} 学分</dd>
            <dt>开课单位</dt><dd>${esc(o.dept || '—')}</dd>
            <dt>授课教师</dt><dd>${esc(o.teacherName)}${o.teacherTitle ? '（' + esc(o.teacherTitle) + '）' : ''}</dd>
            <dt>上课校区</dt><dd>${esc(o.campus || '—')}</dd>
            <dt>名额</dt><dd>${o.enrolled} / ${o.capacity}　余 ${o.remaining}（热度${esc(o.heat)}）</dd>
            <dt>候补人数</dt><dd>${s.waitlistCount || 0} 人</dd>
          </dl>
        </div>
        <div>
          <div class="section-title">上课时间</div>
          <div class="cc-sched">${(o.scheduleText || [])
            .map((x) => `<span class="s">${esc(x)}</span>`)
            .join('') || '<span class="s">排课待定</span>'}</div>
          <div class="section-title mt-16">先修要求</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${prereqHtml}</div>
          <div class="section-title mt-16">本学期学分进度</div>
          <div class="small muted">已选 ${c.credit.total} 学分${
      c.credit.rule ? `，上限 ${c.credit.rule.max_credit} 学分` : ''
    }；选本课后为 ${c.credit.total + o.credit} 学分</div>
        </div>
      </div>

      <div class="sep"></div>
      <div class="section-title">课程简介</div>
      <p style="font-size:13px;color:#475467;line-height:1.75">${esc(o.description || '暂无简介')}</p>

      <div class="sep"></div>
      <div class="section-title">候补队列（前 10 位）</div>
      ${queueHtml}

      <div class="sep"></div>
      <div class="section-title">当前批次</div>
      <p class="small">${
        c.batch
          ? `批次 <strong>${esc(c.batch.name)}</strong>，${fmtTime(c.batch.start_time)} 至 ${fmtTime(c.batch.end_time)}`
          : c.nextBatch
          ? `当前不在批次窗口内，下一批次「${esc(c.nextBatch.name)}」${fmtTime(c.nextBatch.start_time)} 开放`
          : '教务尚未配置批次'
      }</p>
    `;

    const foot = m.mask.querySelector('.modal-foot');
    if (foot) {
      foot.innerHTML = `<button class="btn" data-close-x>关闭</button>`;
      foot.querySelector('[data-close-x]').onclick = () => m.close();
      if (s.selectable) {
        const b = document.createElement('button');
        b.className = 'btn btn-primary';
        b.textContent = '选课';
        b.onclick = async () => {
          m.close();
          if (await doEnroll(ctx, offeringId, o.courseName)) await ctx.reload();
        };
        foot.appendChild(b);
      } else if (s.waitlistable) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = '加入候补';
        b.onclick = async () => {
          m.close();
          if (await doWaitlist(ctx, offeringId, o.courseName)) await ctx.reload();
        };
        foot.appendChild(b);
      } else if (s.myEnrollment) {
        const b = document.createElement('button');
        b.className = 'btn btn-danger';
        b.textContent = '退课';
        b.onclick = async () => {
          m.close();
          if (await doDrop(ctx, offeringId, o.courseName, ctx.state.context?.dropDeadline)) await ctx.reload();
        };
        foot.appendChild(b);
      }
    }
  } catch (e) {
    m.body.innerHTML = `<div class="alert alert-error"><span class="a-ic">✕</span><span>${esc(e.message)}</span></div>`;
  }
}

/* ==================================================================
   我的课表
   ================================================================== */

export async function renderTimetable(root, ctx) {
  let parity = '';
  let compact = false;
  let latest = null;   // 缓存最近一次课表数据，导出时直接用，不再请求

  const paint = async () => {
    const wrap = $('#tt-wrap');
    wrap.innerHTML = loadingState('正在生成课表…');
    const d = await api.get('/api/timetable', parity === '' ? {} : { parity });
    latest = d;
    wrap.innerHTML = buildTimetable(d, compact);
    $('#tt-summary').textContent = `共 ${d.courseCount} 门课程、${d.totalCredit} 学分，课表时段 ${d.cells.length} 个`;
    $('#btn-print').onclick = () => window.print();
  };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2>我的课表</h2>
        <p class="sub" id="tt-summary"></p>
      </div>
      <div class="head-actions no-print">
        <div class="field-inline" style="min-width:130px">
          <select id="tt-parity">
            <option value="">全部周次</option>
            <option value="1">仅单周</option>
            <option value="2">仅双周</option>
          </select>
        </div>
        <label class="checkbox" style="height:34px">
          <input type="checkbox" id="tt-compact" />
          <span>只看有课节次</span>
        </label>
        <button class="btn" id="btn-export-csv" title="导出为 Excel 可直接打开的 CSV">导出 Excel</button>
        <button class="btn" id="btn-export-ics" title="导出为可导入手机日历的文件">导出日历</button>
        <button class="btn" id="btn-print">打印</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3>周视图</h3>
        <div class="head-actions"><span class="small muted">全天 13 节（上午 1~5、下午 6~10、晚上 11~13），单元格显示课程名、教师与上课地点</span></div>
      </div>
      <div class="card-body" id="tt-wrap"></div>
    </div>
  `;

  $('#tt-parity').onchange = async (e) => {
    parity = e.target.value;
    await paint();
  };
  $('#tt-compact').onchange = async (e) => {
    compact = e.target.checked;
    await paint();
  };

  $('#btn-export-csv').onclick = () => {
    if (!latest || !latest.cells.length) return toast('本学期还没有已选课程，暂无可导出的课表', 'warn');
    try {
      exportCsv(latest, '当前学期');
      toast('已导出 CSV，可直接用 Excel 打开', 'success');
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  $('#btn-export-ics').onclick = () => {
    if (!latest || !latest.cells.length) return toast('本学期还没有已选课程，暂无可导出的课表', 'warn');
    try {
      exportIcs(latest, '当前学期');
      toast('已导出日历文件，可在手机日历中导入', 'success');
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  await paint();
}

function buildTimetable(d, compact = false) {
  if (!d.cells.length) return emptyState('本学期还没有已选课程，去选课中心看看吧', '🗓');

  const conflictSet = new Set();
  (d.conflictCells || []).forEach(([a, b]) => {
    conflictSet.add(a);
    conflictSet.add(b);
  });

  // 默认展示完整的一天（13 节，与学校课时表一致）；
  // 勾选「只看有课节次」后压缩到最后一节有课的节次，便于打印。
  const usedMax = d.cells.reduce((m, c) => Math.max(m, c.endPeriod), 0);
  const last = compact && usedMax ? Math.min(usedMax, PERIOD_COUNT) : PERIOD_COUNT;
  const periods = [];
  for (let p = 1; p <= last; p += 1) periods.push(p);

  const colorOf = (id) => 'c' + ((Number(id) % 6) + 1);

  // 时段（上午 / 下午 / 晚上），与课时表一致
  const bandOf = (p) => PERIOD_BAND[p] || '';
  const bandRows = (p) => periods.filter((x) => x >= p && bandOf(x) === bandOf(p)).length;
  const isBandHead = (p) => p === periods[0] || bandOf(p) !== bandOf(p - 1);

  const rows = periods
    .map((p) => {
      const tds = [1, 2, 3, 4, 5, 6, 7]
        .map((wd) => {
          const hit = d.cells.filter((c) => c.weekday === wd && c.startPeriod <= p && c.endPeriod >= p);
          if (!hit.length) return `<td class="empty-cell"></td>`;
          const c = hit[0];
          if (c.startPeriod !== p) return `<td style="display:none"></td>`;
          const span = c.endPeriod - c.startPeriod + 1;
          const isConflict = conflictSet.has(c.offeringId);
          return `<td rowspan="${span}" class="${isConflict ? 'conflict-cell' : ''}">
            <div class="slot ${colorOf(c.offeringId)}">
              <span class="n">${esc(c.courseName)}</span>
              <span class="t">${esc(c.teacherName)}</span>
              <span class="p">${esc(c.place || '地点待定')}</span>
              ${c.parityText !== '全周' ? `<span class="p">${esc(c.parityText)}</span>` : ''}
              ${isConflict ? '<span class="p" style="color:#b42318">存在冲突</span>' : ''}
            </div>
          </td>`;
        })
        .join('');
      const bandCell = isBandHead(p)
        ? `<th class="band" rowspan="${bandRows(p)}"><span class="band-t">${bandOf(p)}</span></th>`
        : '';
      return `<tr>${bandCell}<th class="p-cell"><span class="p-no">第 ${p} 节</span><span class="p-time">${
        PERIOD_TIME[p] || ''
      }</span></th>${tds}</tr>`;
    })
    .join('');

  return `
    <div class="table-wrap">
      <table class="timetable">
        <thead><tr><th>时段</th><th>节次</th>${[1, 2, 3, 4, 5, 6, 7]
          .map((n) => `<th>${WEEKDAY_TEXT[n]}</th>`)
          .join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${
      conflictSet.size
        ? '<div class="alert alert-error mt-16"><span class="a-ic">✕</span><span>检测到课表内存在时间冲突时段，请与教务联系处理。</span></div>'
        : ''
    }`;
}

/* ==================================================================
   我的选课（退课 / 换课）
   ================================================================== */

export async function renderMyCourses(root, ctx) {
  const d = await api.get('/api/enrollments/mine');
  ctx.state.context = d;

  const catHtml = d.byCategory.length
    ? `<div class="cat-credit">${d.byCategory
        .map((c) => {
          const rule = (d.categoryRules || []).find((r) => r.category_id === c.categoryId);
          const target = rule && rule.min_credit ? Number(rule.min_credit) : null;
          const rate = target ? Math.min(1, c.credit / target) : 0;
          return `<div class="cat-credit-item">
            <div class="top"><span>${esc(c.categoryName)}</span><span>${c.credit} 学分${
            target ? ` / 要求 ${target} 学分` : ''
          }</span></div>
            <div class="bar"><i class="${!target || c.credit >= target ? 'ok' : ''}" style="width:${target ? (rate * 100).toFixed(0) : 100}%"></i></div>
          </div>`;
        })
        .join('')}</div>`
    : '<p class="muted small">暂无已选课程</p>';

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2>我的选课</h2>
        <p class="sub">${
          d.batch
            ? `当前批次「${esc(d.batch.name)}」，退课截止 ${fmtTime(d.dropDeadline)}`
            : '当前不在选课批次窗口内'
        }</p>
      </div>
      <div class="head-actions">
        <button class="btn" id="btn-go-course">去选课</button>
      </div>
    </div>

    <div class="stat-grid mb-16">
      <div class="stat">
        <div class="label">已选课程</div>
        <div class="value">${d.list.length}<small>门</small></div>
        <div class="hint">本学期有效选课记录</div>
      </div>
      <div class="stat">
        <div class="label">已选学分</div>
        <div class="value">${d.totalCredit}<small>学分</small></div>
        <div class="hint">${
          d.creditRule ? `上限 ${d.creditRule.max_credit}，下限 ${d.creditRule.min_credit}（仅预警）` : '未配置学分规则'
        }</div>
      </div>
      <div class="stat">
        <div class="label">来源构成</div>
        <div class="value">${d.list.filter((x) => x.source === 2).length}<small>门递补</small></div>
        <div class="hint">来自候补自动递补的课程</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>已选课程</h3></div>
        <div class="card-body tight">
          ${
            d.list.length
              ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>课程</th><th>上课时间</th><th class="num">学分</th><th>来源</th><th>操作</th></tr></thead>
              <tbody>${d.list
                .map(
                  (c) => `<tr>
                  <td>
                    <div class="course-name">${esc(c.course_name)}<span class="course-code">${esc(c.course_code)}</span></div>
                    <div class="cell-sub">${esc(c.teacher_name)} · ${esc(c.category_name)}</div>
                  </td>
                  <td>
                    <div>${(c.scheduleText || []).map((s) => esc(s)).join('<br>') || '排课待定'}</div>
                    <div class="cell-sub">${esc(c.placeText || '')}</div>
                  </td>
                  <td class="num">${c.credit}</td>
                  <td>${c.source === 2 ? '<span class="badge badge-purple">候补递补</span>' : '<span class="badge badge-gray no-dot">正常选课</span>'}</td>
                  <td>
                    <div class="row-actions">
                      <button class="btn btn-sm" data-switch="${c.offering_id}" data-name="${esc(c.course_name)}">换课</button>
                      <button class="btn btn-sm btn-danger" data-drop="${c.offering_id}" data-name="${esc(c.course_name)}">退课</button>
                    </div>
                  </td>
                </tr>`
                )
                .join('')}</tbody></table></div>`
              : emptyState('还没有已选课程', '📚')
          }
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-head"><h3>学分与类别进度</h3></div>
          <div class="card-body">
            ${catHtml}
            <div class="sep"></div>
            <p class="small muted">说明：学分上限用于选课拦截；学分下限仅用于学期末预警，不拦截选课。</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>当前批次</h3></div>
          <div class="card-body">
            <div class="kv-list">
              <div class="kv"><span class="k">批次名称</span><span class="v">${esc(d.batch ? d.batch.name : '不在批次窗口')}</span></div>
              <div class="kv"><span class="k">开放时间</span><span class="v">${
                d.batch ? `${fmtTime(d.batch.start_time)} ~ ${fmtTime(d.batch.end_time)}` : '—'
              }</span></div>
              <div class="kv"><span class="k">退课截止</span><span class="v">${fmtTime(d.dropDeadline)}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  $('#btn-go-course').onclick = () => ctx.go('courses');

  $$('[data-drop]', root).forEach((b) => {
    b.onclick = async () => {
      if (await doDrop(ctx, Number(b.dataset.drop), b.dataset.name, d.dropDeadline)) await ctx.reload();
    };
  });
  $$('[data-switch]', root).forEach((b) => {
    b.onclick = () => openSwitchDialog(ctx, Number(b.dataset.switch), b.dataset.name);
  });
}

async function openSwitchDialog(ctx, fromOfferingId, fromName) {
  const m = openModal({
    title: `换课：${fromName}`,
    wide: true,
    body: loadingState('正在加载可换课程…'),
    footer: null,
  });

  try {
    const data = await api.get('/api/courses', { available: 'true', size: 50, page: 1 });
    const options = data.list.filter((c) => c.offeringId !== fromOfferingId);

    m.body.innerHTML = `
      <div class="alert alert-info"><span class="a-ic">i</span><span>
        换课采用「先占后放」：先校验并预占目标课程名额，成功后再释放原课程名额；
        若目标课程不可选，换课整体不生效，原课程与名额保持不变。</span></div>
      <div class="section-title">选择目标课程（仅列出当前可选的开课）</div>
      ${
        options.length
          ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>课程</th><th>上课时间</th><th class="num">学分</th><th class="num">余量</th><th></th></tr></thead>
              <tbody>${options
                .map(
                  (c) => `<tr>
                  <td><div class="course-name">${esc(c.courseName)}<span class="course-code">${esc(c.courseCode)}</span></div>
                      <div class="cell-sub">${esc(c.teacherName)} · ${esc(c.categoryName)}</div></td>
                  <td>${(c.scheduleText || []).map((s) => esc(s)).join('<br>') || '—'}</td>
                  <td class="num">${c.credit}</td>
                  <td class="num">${c.remaining}</td>
                  <td><button class="btn btn-sm btn-primary" data-pick="${c.offeringId}" data-name="${esc(c.courseName)}">换到这门</button></td>
                </tr>`
                )
                .join('')}</tbody></table></div>`
          : emptyState('当前没有其他可选课程', '🔍')
      }
    `;

    $$('[data-pick]', m.body).forEach((b) => {
      b.onclick = async () => {
        const to = Number(b.dataset.pick);
        m.close();
        const ok = await confirmDialog({
          title: '确认换课',
          text: `将《${fromName}》换为《${b.dataset.name}》？`,
          detail: '换课为单一事务：目标课程预占成功后才会释放原课程名额；任一步失败则整体不生效。',
          confirmText: '确认换课',
        });
        if (!ok) return;
        try {
          const r = await api.post('/api/enrollments/switch', writeBody({ fromOfferingId, toOfferingId: to }));
          const extra =
            r.promoted && r.promoted.length
              ? `原课程名额已递补给候补第 ${r.promoted[0].queueNo} 位同学`
              : '原课程名额已释放';
          toast('换课成功', 'success', extra);
          await ctx.reload();
        } catch (e) {
          handleActionError(e, b.dataset.name);
        }
      };
    });
  } catch (e) {
    m.body.innerHTML = `<div class="alert alert-error"><span class="a-ic">✕</span><span>${esc(e.message)}</span></div>`;
  }
}

/* ==================================================================
   我的候补
   ================================================================== */

export async function renderWaitlist(root, ctx) {
  const d = await api.get('/api/waitlist/mine');
  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2>我的候补</h2>
        <p class="sub">候补按加入时间排队；名额释放后系统自动按排位递补，并对每名候选重新执行完整选课校验。</p>
      </div>
      <div class="head-actions"><button class="btn" id="btn-go">去选课中心</button></div>
    </div>
    <div class="card">
      <div class="card-body tight">
        ${
          d.list.length
            ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>课程</th><th>候补排位</th><th>状态</th><th>加入时间</th><th>递补确认期</th><th>操作</th></tr></thead>
            <tbody>${d.list
              .map(
                (w) => `<tr>
                <td>
                  <div class="course-name">${esc(w.course_name)}<span class="course-code">${esc(w.course_code)}</span></div>
                  <div class="cell-sub">${esc(w.teacher_name)} · ${esc(w.category_name)} · ${w.credit} 学分</div>
                </td>
                <td>第 ${w.queue_no} 位<span class="cell-sub">（前方 ${w.aheadCount} 人）</span></td>
                <td>${
                  w.status === 2
                    ? '<span class="badge badge-green">已递补</span>'
                    : '<span class="badge badge-purple">候补中</span>'
                }</td>
                <td>${fmtTime(w.join_time)}</td>
                <td>${w.expire_time ? fmtTime(w.expire_time) : '—'}</td>
                <td>
                  <div class="row-actions">
                    ${
                      w.status === 2
                        ? `<button class="btn btn-sm btn-primary" data-confirm="${w.offering_id}">确认名额</button>`
                        : `<button class="btn btn-sm btn-danger" data-cancel="${w.offering_id}" data-name="${esc(w.course_name)}">取消候补</button>`
                    }
                  </div>
                </td>
              </tr>`
              )
              .join('')}</tbody></table></div>`
            : emptyState('暂无候补记录，课程满员时可加入候补', '⏳')
        }
      </div>
    </div>
  `;

  $('#btn-go').onclick = () => ctx.go('courses');

  $$('[data-cancel]', root).forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmDialog({
        title: '取消候补',
        text: `确认取消《${b.dataset.name}》的候补？取消后需要重新排队。`,
        confirmText: '确认取消',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/waitlist/${b.dataset.cancel}`, writeBody({}));
        toast('已取消候补', 'success');
        await ctx.reload();
      } catch (e) {
        handleActionError(e, b.dataset.name);
      }
    };
  });

  $$('[data-confirm]', root).forEach((b) => {
    b.onclick = async () => {
      try {
        await api.post(`/api/waitlist/${b.dataset.confirm}/confirm`);
        toast('已确认递补名额', 'success');
        await ctx.reload();
      } catch (e) {
        handleActionError(e, '');
      }
    };
  });
}

/* ==================================================================
   通知中心
   ================================================================== */

export async function renderNotices(root, ctx) {
  let type = '';
  let data = null;

  const paint = async () => {
    const box = $('#notice-box');
    box.innerHTML = loadingState();
    data = await api.get('/api/notices', { size: 50, type });
    ctx.state.unread = data.unread;
    if (ctx.state.profile) {
      const badge = document.getElementById('unread-badge');
      if (badge) {
        badge.hidden = data.unread === 0;
        badge.textContent = data.unread > 99 ? '99+' : String(data.unread);
      }
    }
    box.innerHTML = data.list.length
      ? data.list
          .map(
            (n) => `<div class="notice-item ${n.is_read ? '' : 'unread'}">
            <div class="n-body">
              <div class="n-title">
                ${esc(n.title)}
                <span class="tag">${esc(n.typeText)}</span>
                ${n.is_read ? '' : '<span class="badge badge-blue">未读</span>'}
              </div>
              <div class="n-text">${esc(n.content)}</div>
              <div class="n-time">${fmtTime(n.created_at)}　·　${esc(relativeTime(n.created_at))}</div>
            </div>
            <div class="n-side">
              ${n.related_id ? `<button class="btn btn-sm" data-view="${n.related_id}">查看课程</button>` : ''}
              ${n.is_read ? '' : `<button class="btn btn-sm" data-read="${n.id}">标记已读</button>`}
            </div>
          </div>`
          )
          .join('')
      : emptyState('暂无通知', '🔔');

    $$('[data-read]', box).forEach((b) => {
      b.onclick = async () => {
        await api.post(`/api/notices/${b.dataset.read}/read`);
        await paint();
      };
    });
    $$('[data-view]', box).forEach((b) => {
      b.onclick = async () => {
        await openCourseDetail(Number(b.dataset.view), ctx);
        await paint();
      };
    });
  };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h2>通知中心</h2>
        <p class="sub" id="notice-sub"></p>
      </div>
      <div class="head-actions">
        <div class="field-inline" style="min-width:140px">
          <select id="n-type">
            <option value="">全部类型</option>
            <option value="1">选课结果</option>
            <option value="2">候补递补</option>
            <option value="3">递补失败</option>
            <option value="4">退课</option>
            <option value="5">公告</option>
          </select>
        </div>
        <button class="btn" id="btn-read-all">全部标记已读</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>通知列表</h3><div class="head-actions"><span class="small muted">未读通知会以角标提示</span></div></div>
      <div class="card-body tight" id="notice-box"></div>
    </div>
  `;

  $('#n-type').onchange = async (e) => {
    type = e.target.value;
    await paint();
  };
  $('#btn-read-all').onclick = async () => {
    await api.post('/api/notices/read-all');
    toast('已全部标记为已读', 'success');
    await paint();
    await ctx.refreshUnread();
  };

  await paint();
  const sub = $('#notice-sub');
  if (sub) sub.textContent = `共 ${data.total} 条通知，未读 ${data.unread} 条`;
}

/* ==================================================================
   选课规则
   ================================================================== */

/** 课时表（与学校《课时表》一致）：上午 1~5 节、下午 6~10 节、晚上 11~13 节 */
function periodTableHtml() {
  const periods = Array.from({ length: PERIOD_COUNT }, (_, i) => i + 1);
  const bandOf = (p) => PERIOD_BAND[p] || '';
  const groupOf = (p) => PERIOD_GROUP[p] || '';
  const run = (p, key) => periods.filter((x) => x >= p && key(x) === key(p)).length;

  const rows = periods
    .map((p) => {
      const bandCell =
        p === 1 || bandOf(p) !== bandOf(p - 1)
          ? `<td rowspan="${run(p, bandOf)}" class="pt-band">${bandOf(p)}</td>`
          : '';
      const groupCell =
        p === 1 || groupOf(p) !== groupOf(p - 1)
          ? `<td rowspan="${run(p, groupOf)}" class="pt-group">${groupOf(p)}</td>`
          : '';
      return `<tr>${bandCell}${groupCell}<td class="pt-no">${p}</td><td class="pt-time">${
        PERIOD_TIME[p] || ''
      }</td></tr>`;
    })
    .join('');

  return `
    <div class="table-wrap pt-wrap">
      <table class="data period-table">
        <thead><tr><th style="width:76px">时间</th><th style="width:64px">大节</th><th style="width:64px">小节</th><th>起止时间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted small" style="margin-top:10px">每节 40 分钟，同一大节内的小节连排，大节之间设 20 分钟课间。课表、选课与冲突检测均以本节次时间表为准。</p>
  `;
}

export async function renderRules(root, ctx) {
  const d = await api.get('/api/enrollments/mine');
  const announcements = await api.get('/api/announcements');

  const batches = [];
  root.innerHTML = `
    <div class="page-head">
      <div><h2>选课规则</h2><p class="sub">规则由教务配置，服务端强制执行，页面提示仅作辅助</p></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>当前生效批次</h3></div>
        <div class="card-body">
          <div class="kv-list">
            <div class="kv"><span class="k">批次名称</span><span class="v">${esc(d.batch ? d.batch.name : '不在批次窗口')}</span></div>
            <div class="kv"><span class="k">开放时间</span><span class="v">${
              d.batch ? `${fmtTime(d.batch.start_time)} ~ ${fmtTime(d.batch.end_time)}` : '—'
            }</span></div>
            <div class="kv"><span class="k">目标人群</span><span class="v">${
              d.batch ? `${esc(d.batch.target_grade || '不限年级')} / ${esc(d.batch.target_college || '不限学院')}` : '—'
            }</span></div>
            <div class="kv"><span class="k">批次类型</span><span class="v">${
              d.batch ? (d.batch.type === 2 ? '补退选' : '正常选课') : '—'
            }</span></div>
            <div class="kv"><span class="k">退课截止</span><span class="v">${fmtTime(d.dropDeadline)}</span></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>本学期学分要求</h3></div>
        <div class="card-body">
          <div class="kv-list">
            <div class="kv"><span class="k">已选学分</span><span class="v">${d.totalCredit} 学分</span></div>
            <div class="kv"><span class="k">学分上限（拦截）</span><span class="v">${
              d.creditRule ? d.creditRule.max_credit + ' 学分' : '未配置'
            }</span></div>
            <div class="kv"><span class="k">学分下限（仅预警）</span><span class="v">${
              d.creditRule ? d.creditRule.min_credit + ' 学分' : '未配置'
            }</span></div>
          </div>
          <div class="sep"></div>
          <div class="section-title">类别学分要求</div>
          ${
            (d.categoryRules || []).length
              ? `<div class="cat-credit">${d.categoryRules
                  .map((r) => {
                    const got = (d.byCategory || []).find((c) => c.categoryId === r.category_id);
                    const cur = got ? got.credit : 0;
                    const target = r.min_credit ? Number(r.min_credit) : null;
                    return `<div class="cat-credit-item">
                      <div class="top"><span>${esc(r.category_name)}</span><span>${cur} 学分${
                      target ? ` / 要求 ${target} 学分` : ''
                    }</span></div>
                      <div class="bar"><i class="${!target || cur >= target ? 'ok' : ''}" style="width:${
                      target ? Math.min(100, (cur / target) * 100).toFixed(0) : 100
                    }%"></i></div>
                    </div>`;
                  })
                  .join('')}</div>`
              : '<p class="muted small">教务尚未配置类别学分要求</p>'
          }
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>课时表（节次时间）</h3></div>
      <div class="card-body">${periodTableHtml()}</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>规则说明</h3></div>
      <div class="card-body">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th style="width:130px">规则项</th><th>具体内容</th></tr></thead>
            <tbody>
              <tr><td>时间与批次</td><td>分批次开放，设起止时间与目标人群，按年级错峰分流；同一学生命中多个批次时取优先级最高（priority 最小）且处于时间窗口内的批次。</td></tr>
              <tr><td>节次时间</td><td>全校统一按课时表执行：每天 13 节、每节 40 分钟，上午为第 1~5 节（08:00 起）、下午为第 6~10 节（13:00 起）、晚上为第 11~13 节（18:00 起）。</td></tr>
              <tr><td>容量与热度</td><td>每个开课设定容量上限，余量等于容量减已选人数。热度由利用率推导：不低于 90% 为「高」，60% 至 90% 为「中」，低于 60% 为「低」。</td></tr>
              <tr><td>时间冲突检测</td><td>判定维度为上课星期、节次区间与单双周：星期相同、节次区间相交且单双周不互斥时判定为冲突；一门课存在多个时段时，任一时段冲突即整体冲突。跨校区不作为冲突条件，但相邻节次分处不同校区会给出赶课提示。</td></tr>
              <tr><td>学分规则</td><td>上限用于选课拦截，超过上限禁止选课；下限仅用于学期末预警，不拦截选课；类别学分要求按学期配置，选课时给出进度提示。</td></tr>
              <tr><td>先修要求</td><td>具有先修要求的课程需已通过对应先修课程，支持「与」（全部满足）与「或」（满足其一）两种关系；未满足时禁止选课并提示缺失课程。</td></tr>
              <tr><td>退课</td><td>在退课截止时间前可自由退课，退课后名额立即释放并触发候补递补；截止后仅教务管理员可人工办理。</td></tr>
              <tr><td>换课</td><td>采用单一事务的「先占后放」：先校验并预占目标课程名额，成功后再释放原课程名额；目标不可选时整体不生效，原课程保持不变。</td></tr>
              <tr><td>候补递补</td><td>满员可加入候补，按加入时间排队；名额释放后取排位最靠前的学生，重新执行完整选课校验，通过则生成选课记录并通知，不通过则顺延下一名。</td></tr>
              <tr><td>防脚本刷课</td><td>同一账号在 60 秒内超过 10 次选课写请求触发限速，超过 20 次要求完成安全验证；阈值可配置。</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>教务公告</h3></div>
      <div class="card-body">
        ${
          announcements.list.length
            ? announcements.list
                .map(
                  (a) => `<div style="padding:12px 0;border-bottom:1px dashed #e2e8f0">
                  <div style="font-weight:600;font-size:13.5px">${esc(a.title)}</div>
                  <div class="small muted" style="margin-top:4px">${esc(a.publisher_name)} · ${fmtTime(a.publish_time)}</div>
                  <p style="margin-top:6px;font-size:13px;color:#475467;line-height:1.75">${esc(a.content)}</p>
                </div>`
                )
                .join('')
            : emptyState('暂无公告', '📢')
        }
      </div>
    </div>
  `;
  void batches;
}
