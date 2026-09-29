/**
 * 诊断：全量扫描所有学生的已选课程，找出课表内时间冲突。
 */
const path = require('path');
const mysql = require(path.join(__dirname, '..', 'node_modules', 'mysql2', 'promise'));
const conf = require(path.join(__dirname, '..', 'config', 'config.js'));

(async () => {
  const conn = await mysql.createConnection({
    host: conf.db.host,
    port: conf.db.port,
    user: conf.db.user,
    password: conf.db.password,
    database: conf.db.database,
  });

  const [term] = await conn.query(`SELECT id, name FROM t_term WHERE is_current = 1 LIMIT 1`);
  const termId = term[0].id;
  console.log(`学期：${term[0].name} (id=${termId})`);

  const [enrolls] = await conn.query(
    `SELECT e.student_id, s.student_no, u.real_name, e.offering_id, c.course_code, c.name AS course_name
       FROM t_enrollment e
       JOIN t_student s ON s.id = e.student_id
       JOIN t_user u ON u.id = s.user_id
       JOIN t_course_offering o ON o.id = e.offering_id
       JOIN t_course c ON c.id = o.course_id
      WHERE o.term_id = ? AND e.status = 1
      ORDER BY s.student_no, c.course_code`,
    [termId]
  );

  const [scheds] = await conn.query(
    `SELECT sc.offering_id, sc.weekday, sc.start_period, sc.end_period, sc.parity
       FROM t_course_schedule sc
       JOIN t_course_offering o ON o.id = sc.offering_id
      WHERE o.term_id = ?`,
    [termId]
  );
  const byOffering = new Map();
  scheds.forEach((s) => {
    if (!byOffering.has(s.offering_id)) byOffering.set(s.offering_id, []);
    byOffering.get(s.offering_id).push(s);
  });

  const byStudent = new Map();
  enrolls.forEach((e) => {
    if (!byStudent.has(e.student_id)) byStudent.set(e.student_id, { no: e.student_no, name: e.real_name, list: [] });
    const slots = byOffering.get(e.offering_id) || [];
    byStudent.get(e.student_id).list.push({ code: e.course_code, name: e.course_name, slots });
  });

  let total = 0;
  let badStudents = 0;
  for (const [sid, st] of byStudent) {
    const flat = [];
    st.list.forEach((c) => c.slots.forEach((s) => flat.push({ ...s, code: c.code, name: c.name })));
    let n = 0;
    for (let i = 0; i < flat.length; i += 1) {
      for (let j = i + 1; j < flat.length; j += 1) {
        const a = flat[i];
        const b = flat[j];
        if (
          a.weekday === b.weekday &&
          a.start_period <= b.end_period &&
          b.start_period <= a.end_period &&
          !((a.parity === 1 && b.parity === 2) || (a.parity === 2 && b.parity === 1))
        ) {
          n += 1;
          console.log(
            `  ✗ ${st.no} ${st.name}：周${a.weekday} [${a.code}]${a.start_period}-${a.end_period}节(${a.parity || '全'}) × [${b.code}]${b.start_period}-${b.end_period}节(${b.parity || '全'})`
          );
        }
      }
    }
    if (n) {
      total += n;
      badStudents += 1;
    }
  }
  console.log(`\n学生 ${byStudent.size} 人，冲突学生 ${badStudents} 人，冲突 ${total} 处`);
  await conn.end();
})().catch((e) => {
  console.error('诊断失败：', e.message);
  process.exit(1);
});
