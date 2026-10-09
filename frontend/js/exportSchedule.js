/**
 * 课表导出（CSV / ICS）
 *
 * 设计要点：
 * 1. 纯前端实现，不新增后端接口 —— 数据已经在课表页拿到的 d.cells 里，
 *    再请求一次只是浪费；也保证了「单文件版」同样可用（不依赖后端）。
 * 2. 两种格式对应两类真实需求：
 *    - CSV：用 Excel 打开做二次处理、交给辅导员核对学分；
 *    - ICS：导入手机日历（iOS 日历 / 小米 / 华为 / Google Calendar），
 *           带重复规则与地点，上课前能收到提醒。
 * 3. 全部走 Blob + <a download>，不依赖任何库。
 */

import { PERIOD_TIME, WEEKDAY_TEXT } from './ui.js';

/** 导出文件名统一加日期，避免多次导出互相覆盖 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 把 08:00-08:40 拆成 [开始, 结束] */
function timeRange(startPeriod, endPeriod) {
  const a = PERIOD_TIME[startPeriod] || '';
  const b = PERIOD_TIME[endPeriod] || a;
  if (!a) return ['', ''];
  return [a.slice(0, 5), (b || a).slice(6)];
}

/** 触发浏览器下载 */
function download(filename, content, mime) {
  // CSV 前置 BOM（U+FEFF），Excel 打开中文才不会乱码——这是最常踩的坑。
  // 直接拼进字符串而不是作为 Blob 的独立分段：某些实现（如 jsdom）会丢弃
  // 单独成段的 BOM，拼进正文才能保证任何环境下都在首字节。
  const body = mime === 'text/csv' ? '\ufeff' + content : content;
  const blob = new Blob([body], { type: `${mime};charset=utf-8` });
  // 显式用 window.URL：浏览器里等价于裸 URL，但在 jsdom 等测试环境下
  // 能把 URL 明确指向 DOM 实现（jsdom 未实现 createObjectURL，需要测试侧补 polyfill）
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立即释放会让部分浏览器来不及下载，延迟回收
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

/** CSV 字段转义：含逗号/引号/换行时用双引号包裹 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 导出为 CSV（Excel 可直接打开）。
 *
 * 两种视角都给出，因为用途不同：
 *   明细区：一行一个上课时段，便于筛选、排序、统计课时；
 *   周视图：与页面上的课表同构，便于打印或贴进作业文档。
 */
export function exportCsv(d, termName = '') {
  const cells = d.cells || [];
  const lines = [];

  lines.push(['选课系统 · 我的课表'].map(csvCell).join(','));
  lines.push([`学期：${termName || '当前学期'}`, `导出日期：${new Date().toLocaleString('zh-CN')}`].map(csvCell).join(','));
  lines.push([`课程数：${d.courseCount}`, `总学分：${d.totalCredit}`].map(csvCell).join(','));
  lines.push('');

  // ---------- 区段一：课程明细 ----------
  lines.push('【课程明细】');
  lines.push(['课程名称', '课程代码', '教师', '学分', '类别', '星期', '节次', '上课时间', '周次', '地点', '来源']
    .map(csvCell).join(','));

  // 按星期 + 开始节次排序，与人看课表的顺序一致
  const sorted = cells.slice().sort((a, b) => (a.weekday - b.weekday) || (a.startPeriod - b.startPeriod));
  for (const c of sorted) {
    const [t1, t2] = timeRange(c.startPeriod, c.endPeriod);
    lines.push([
      c.courseName || '',
      c.courseCode || '',
      c.teacherName || '',
      c.credit ?? '',
      c.categoryName || '',
      WEEKDAY_TEXT[c.weekday] || '',
      `第 ${c.startPeriod}-${c.endPeriod} 节`,
      t1 ? `${t1}~${t2}` : '',
      c.parityText || '全周',
      c.place || '地点待定',
      c.source === 'waitlist' || c.source === 'PROMOTED' ? '候补递补' : '正常选课',
    ].map(csvCell).join(','));
  }

  // ---------- 区段二：周视图网格 ----------
  // 只输出「有课」的时段范围，避免 13 行空行
  lines.push('');
  lines.push('【周视图】');
  const maxPeriod = cells.reduce((m, c) => Math.max(m, c.endPeriod), 0);
  lines.push(['节次', '上课时间', WEEKDAY_TEXT[1], WEEKDAY_TEXT[2], WEEKDAY_TEXT[3],
    WEEKDAY_TEXT[4], WEEKDAY_TEXT[5], WEEKDAY_TEXT[6], WEEKDAY_TEXT[7]].map(csvCell).join(','));

  for (let p = 1; p <= maxPeriod; p++) {
    const row = [`第 ${p} 节`, PERIOD_TIME[p] || ''];
    for (let wd = 1; wd <= 7; wd++) {
      const hit = cells.find((c) => c.weekday === wd && c.startPeriod <= p && c.endPeriod >= p);
      if (hit && hit.startPeriod === p) {
        // 跨节次的课只在起始节写全名，后续格用「↑」占位
        row.push(`${hit.courseName}（${hit.teacherName}）`);
      } else if (hit) {
        row.push('↑');
      } else {
        row.push('');
      }
    }
    lines.push(row.map(csvCell).join(','));
  }

  download(`我的课表-${stamp()}.csv`, lines.join('\r\n'), 'text/csv');
}

/* ------------------------------------------------------------------ */
/* ICS（iCalendar RFC 5545）                                          */
/* ------------------------------------------------------------------ */

/** 把 JS Date 转成 ICS 的 UTC 时间格式：YYYYMMDDTHHMMSSZ */
function icsStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

/**
 * 以「本周一」为基准算出某个星期几对应的日期。
 * ICS 用 BYDAY 做周重复，需要一个明确的 DTSTART 作为锚点。
 */
function dateOfWeekday(baseMonday, weekday, hour, minute) {
  const d = new Date(baseMonday.getTime());
  d.setDate(d.getDate() + (weekday - 1));
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** ICS 文本转义：反斜杠、分号、逗号、换行 */
function icsEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** ICS 单行内容按 75 字节折行（RFC 5545 要求，粘得过长的行会被部分客户端忽略） */
function fold(line) {
  // 简化实现：按字符切分，首行 74 字符、续行 73 字符（续行须以空格开头）。
  // 中文字符占 3 字节，实际折行点会比 75 字节更靠前，属于安全方向。
  if (line.length <= 74) return line;
  const out = [];
  let cur = line;
  out.push(cur.slice(0, 74));
  cur = cur.slice(74);
  while (cur.length > 0) {
    out.push(' ' + cur.slice(0, 73));
    cur = cur.slice(73);
  }
  return out.join('\r\n');
}

/**
 * 导出为 ICS（可导入手机 / 桌面日历）。
 *
 * 说明几点设计取舍：
 * - 用 WEEKLY 重复 + 结束日期而不是逐周展开：一份 18 周的课表只生成十几条事件，
 *   而不是几百条，导入更快、修改更方便（改一次是改整条重复规则）。
 * - 单双周无法用一条 WEEKLY 规则表达，因此按「单周」「双周」各生成一条，
 *   间隔 2 周（INTERVAL=2），锚点分别落在第 1 周与第 2 周。
 * - 提前 15 分钟提醒，比不提醒实用得多。
 */
export function exportIcs(d, termName = '', weeks = 18) {
  const cells = d.cells || [];
  if (!cells.length) return false;

  // 以「下周一」为基准，避免导出后立刻出现已经过去的事件
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  const day = monday.getDay();               // 0=周日
  const deltaToNextMonday = day === 1 ? 0 : (8 - day) % 7 || 7;
  monday.setDate(monday.getDate() + deltaToNextMonday);

  const lastDate = new Date(monday.getTime());
  lastDate.setDate(lastDate.getDate() + weeks * 7);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Campus Course Selection System//Timetable Export//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEsc(`我的课表${termName ? ' · ' + termName : ''}`)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
  ];

  // 稳定的 UID：同一门课每次导出都能覆盖旧事件，而不是越导越多
  const uidBase = `${stamp()}-${cells.length}`;

  cells.forEach((c, idx) => {
    const [t1, t2] = timeRange(c.startPeriod, c.endPeriod);
    if (!t1) return;
    const [h1, m1] = t1.split(':').map(Number);
    const [h2, m2] = t2.split(':').map(Number);

    // parity：0 全周 / 1 单周 / 2 双周
    // 周次锚点：全周与单周从第 1 周开始，双周从第 2 周开始
    const startWeekOffset = c.parity === 2 ? 1 : 0;
    const interval = c.parity === 1 || c.parity === 2 ? 2 : 1;

    const start = dateOfWeekday(monday, c.weekday, h1, m1);
    start.setDate(start.getDate() + startWeekOffset * 7);
    const end = dateOfWeekday(monday, c.weekday, h2, m2);
    end.setDate(end.getDate() + startWeekOffset * 7);
    // 有些节的结束时间早于开始时间（跨 12:00 的写法），用 +40 分钟兜底
    if (end <= start) end.setTime(start.getTime() + 40 * 60 * 1000);

    const until = new Date(lastDate.getTime());
    const summary = c.courseName || '课程';
    const descParts = [];
    if (c.courseCode) descParts.push(`课程代码：${c.courseCode}`);
    if (c.teacherName) descParts.push(`授课教师：${c.teacherName}`);
    if (c.credit !== undefined && c.credit !== null) descParts.push(`学分：${c.credit}`);
    if (c.parityText && c.parityText !== '全周') descParts.push(`周次：${c.parityText}`);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:course-${c.offeringId}-${idx}-${uidBase}@campus.local`);
    lines.push(`DTSTAMP:${icsStamp(new Date())}`);
    lines.push(`DTSTART:${icsStamp(start)}`);
    lines.push(`DTEND:${icsStamp(end)}`);
    lines.push(`RRULE:FREQ=WEEKLY;INTERVAL=${interval};UNTIL=${icsStamp(until)}`);
    lines.push(fold(`SUMMARY:${icsEsc(summary)}`));
    if (c.place) lines.push(fold(`LOCATION:${icsEsc(c.place)}`));
    if (descParts.length) lines.push(fold(`DESCRIPTION:${icsEsc(descParts.join('\\n'))}`));
    // 提前 15 分钟提醒
    lines.push('BEGIN:VALARM');
    lines.push('TRIGGER:-PT15M');
    lines.push('ACTION:DISPLAY');
    lines.push(fold(`DESCRIPTION:${icsEsc(`${summary} 即将开始`)}`));
    lines.push('END:VALARM');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  download(`我的课表-${stamp()}.ics`, lines.join('\r\n'), 'text/calendar');
  return true;
}
