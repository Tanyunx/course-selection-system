/**
 * 诊断：输出排课全景（课程/教师/时段/教室/选课学生），便于人工判断可调整的空档。
 */
const path = require('path');
const mysql = require(path.join(__dirname, '..', 'node_modules', 'mysql2', 'promise'));
const conf = require(path.join(__dirname, '..', 'config', 'config.js'));

const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

(async () => {
  const conn = await mysql.createConnection({
    host: conf.db.host,
    port: conf.db.port,
    user: conf.db.user,
    password: conf.db.password,
    database: conf.db.database,
  });

  const [off] = await conn.query(
    `SELECT o.id, c.course_code, c.name AS course_name, tu.real_name AS teacher,
            o.capacity, o.enrolled, o.campus
       FROM t_course_offering o
       JOIN t_course c ON c.id = o.course_id
       JOIN t_teacher t ON t.id = o.teacher_id
       JOIN t_user tu ON tu.id = t.user_id
      WHERE o.term_id = 2
      ORDER BY o.id`
  );
  const [sc] = await conn.query(
    `SELECT offering_id, weekday, start_period, end_period, parity, building, room
       FROM t_course_schedule WHERE offering_id IS NOT NULL ORDER BY weekday, start_period`
  );
  const [en] = await conn.query(
    `SELECT e.offering_id, s.student_no, u.real_name
       FROM t_enrollment e
       JOIN t_student s ON s.id = e.student_id
       JOIN t_user u ON u.id = s.user_id
      WHERE e.status = 1`
  );

  console.log('offering | 课程 | 教师 | 已选/容量 | 时段 | 教室 | 选课学生');
  off.forEach((o) => {
    const slots = sc
      .filter((s) => s.offering_id === o.id)
      .map((s) => `${WD[s.weekday]}${s.start_period}-${s.end_period}节${s.parity ? (s.parity === 1 ? '单' : '双') : ''}`)
      .join(' + ');
    const rooms = [...new Set(sc.filter((s) => s.offering_id === o.id).map((s) => `${s.building}${s.room}`))].join('/');
    const studs = en.filter((e) => e.offering_id === o.id).map((e) => `${e.student_no}${e.real_name}`).join(',');
    console.log(`  ${o.id} | [${o.course_code}]${o.course_name} | ${o.teacher} | ${o.enrolled}/${o.capacity} | ${slots || '—'} | ${rooms} | ${studs || '—'}`);
  });

  // 教室占用表
  console.log('\n教室占用（周次-节次）：');
  const roomMap = new Map();
  sc.forEach((s) => {
    const key = `${s.building}${s.room}`;
    if (!roomMap.has(key)) roomMap.set(key, []);
    roomMap.get(key).push(`${WD[s.weekday]}${s.start_period}-${s.end_period}(#${s.offering_id})`);
  });
  [...roomMap.entries()].forEach(([k, v]) => console.log(`  ${k}: ${v.join(', ')}`));

  // 教师占用表
  console.log('\n教师占用（周次-节次）：');
  const tMap = new Map();
  off.forEach((o) => {
    const slots = sc.filter((s) => s.offering_id === o.id);
    slots.forEach((s) => {
      if (!tMap.has(o.teacher)) tMap.set(o.teacher, []);
      tMap.get(o.teacher).push(`${WD[s.weekday]}${s.start_period}-${s.end_period}(#${o.id})`);
    });
  });
  [...tMap.entries()].forEach(([k, v]) => console.log(`  ${k}: ${v.join(', ')}`));

  await conn.end();
})().catch((e) => {
  console.error('诊断失败：', e.message);
  process.exit(1);
});
