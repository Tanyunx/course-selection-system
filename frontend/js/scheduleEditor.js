/**
 * 排课时段编辑器（教师端与教务端共用）。
 * 一个开课可包含多个上课时段，每个时段由星期、起止节次、单双周与地点构成。
 */

import { esc, WEEKDAY_TEXT, PERIOD_COUNT, PERIOD_TIME } from './ui.js';

const PERIOD_OPTIONS = Array.from({ length: PERIOD_COUNT }, (_, i) => i + 1);
const PARITY_OPTIONS = [
  { value: 0, label: '全周' },
  { value: 1, label: '单周' },
  { value: 2, label: '双周' },
];

let seq = 0;

function rowHtml(s = {}) {
  const id = `se-${++seq}`;
  return `
    <tr data-row="${id}">
      <td>
        <select data-k="weekday">
          ${WEEKDAY_TEXT.slice(1)
            .map((t, i) => `<option value="${i + 1}" ${Number(s.weekday) === i + 1 ? 'selected' : ''}>${t}</option>`)
            .join('')}
        </select>
      </td>
      <td><select data-k="startPeriod">${PERIOD_OPTIONS.map(
        (p) =>
          `<option value="${p}" ${Number(s.start_period || s.startPeriod) === p ? 'selected' : ''}>${p} 节 ${
            PERIOD_TIME[p] || ''
          }</option>`
      ).join('')}</select></td>
      <td><select data-k="endPeriod">${PERIOD_OPTIONS.map(
        (p) =>
          `<option value="${p}" ${Number(s.end_period || s.endPeriod) === p ? 'selected' : ''}>${p} 节 ${
            PERIOD_TIME[p] || ''
          }</option>`
      ).join('')}</select></td>
      <td><select data-k="parity">${PARITY_OPTIONS.map(
        (p) => `<option value="${p.value}" ${Number(s.parity || 0) === p.value ? 'selected' : ''}>${p.label}</option>`
      ).join('')}</select></td>
      <td><input type="text" data-k="campus" value="${esc(s.campus || '')}" placeholder="校区" /></td>
      <td><input type="text" data-k="building" value="${esc(s.building || '')}" placeholder="教学楼" /></td>
      <td><input type="text" data-k="room" value="${esc(s.room || '')}" placeholder="教室" /></td>
      <td><button type="button" class="btn btn-sm btn-ghost" data-remove>删除</button></td>
    </tr>`;
}

/**
 * @param {Array} schedules 初始排课（可来自接口字段）
 * @returns {{ html: string, mount: (root:HTMLElement)=>void, read: ()=>Array, count: ()=>number }}
 */
export function scheduleEditor(schedules = []) {
  const initial = schedules.length
    ? schedules
    : [{ weekday: 1, start_period: 1, end_period: 2, parity: 0, campus: '', building: '', room: '' }];

  const html = `
    <div class="schedule-editor">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>星期</th><th>起始节</th><th>结束节</th><th>单双周</th><th>校区</th><th>教学楼</th><th>教室</th><th></th></tr>
          </thead>
          <tbody data-rows>${initial.map(rowHtml).join('')}</tbody>
        </table>
      </div>
      <button type="button" class="btn btn-sm mt-8" data-add>+ 添加时段</button>
      <p class="small muted mt-8">说明：一门课可设置多个上课时段；节次区间用于时间冲突检测，单双周参与冲突判定。</p>
    </div>`;

  function mount(root) {
    const tbody = root.querySelector('[data-rows]');
    root.querySelector('[data-add]').onclick = () => {
      tbody.insertAdjacentHTML('beforeend', rowHtml({ weekday: 1, start_period: 1, end_period: 2, parity: 0 }));
      bindRemove();
    };
    function bindRemove() {
      tbody.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = () => {
          if (tbody.querySelectorAll('tr').length <= 1) return;
          b.closest('tr').remove();
        };
      });
    }
    bindRemove();
  }

  function read(root = document) {
    return Array.from(root.querySelectorAll('[data-rows] tr')).map((tr) => {
      const get = (k) => {
        const el = tr.querySelector(`[data-k="${k}"]`);
        return el ? el.value : '';
      };
      return {
        weekday: Number(get('weekday')),
        startPeriod: Number(get('startPeriod')),
        endPeriod: Number(get('endPeriod')),
        parity: Number(get('parity')),
        campus: get('campus').trim(),
        building: get('building').trim(),
        room: get('room').trim(),
      };
    });
  }

  const count = (root = document) => root.querySelectorAll('[data-rows] tr').length;

  return { html, mount, read, count };
}
