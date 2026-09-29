/**
 * 诊断：列出学生 2024001 在当学期的已选课程及其排课时段，逐对判定是否时间冲突。
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
    multipleStatements: false,
  });

  const [stu] = await conn.query(
    `SELECT s.id, s.student_no FROM t_student s WHERE s.student_no = '2024001'`
  );
  if (!stu.length) {
    console.log('未找到学生 2024001');
    await conn.end();
    return;
  }
  const studentId = stu[0].id;

  const [term] = await conn.query(
    `SELECT id, name FROM t_term WHERE is_current = 1 LIMIT 1`
  );
  const termId = term.length ? term[0].id : null;
  console.log('当前学期：', term.length ? `${term[0].name} (id=${termId})` : '无');

  const [rows] = await conn.query(
    `SELECT e.offering_id, c.course_code, c.name AS course_name, o.status AS offering_status
       FROM t_enrollment e
       JOIN t_course_offering o ON o.id = e.offering_id
       JOIN t_course c ON c.id = o.course_id
      WHERE e.student_id = ? AND o.term_id = ? AND e.status = 1
      ORDER BY c.course_code`,
    [studentId, termId]
  );

  console.log(`\n已选课程 ${rows.length} 门：`);
  const all = [];
  for (const r of rows) {
    const [sc] = await conn.query(
      `SELECT weekday, start_period, end_period, parity FROM t_course_schedule WHERE offering_id = ? ORDER BY weekday, start_period`,
      [r.offering_id]
    );
    const text = sc
      .map((s) => `周${s.weekday} ${s.start_period}-${s.end_period}节${s.parity ? (s.parity === 1 ? '单' : '双') : '全'}`)
      .join(' / ');
    console.log(`  - [${r.course_code}] ${r.course_name}  ${text || '(无排课)'}`);
    sc.forEach((s) => all.push({ ...s, code: r.course_code, name: r.course_name, oid: r.offering_id }));
  }

  console.log('\n冲突判定：');
  let n = 0;
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      const sameDay = a.weekday === b.weekday;
      const overlap = a.start_period <= b.end_period && b.start_period <= a.end_period;
      const parityOk = !((a.parity === 1 && b.parity === 2) || (a.parity === 2 && b.parity === 1));
      if (sameDay && overlap && parityOk) {
        n += 1;
        console.log(
          `  ✗ [${a.code}] 周${a.weekday} ${a.start_period}-${a.end_period}节(${a.parity || '全'}) 与 [${b.code}] 周${b.weekday} ${b.start_period}-${b.end_period}节(${b.parity || '全'})`
        );
      }
    }
  }
  console.log(n ? `\n共 ${n} 处冲突` : '\n无冲突');

  await conn.end();
})().catch((e) => {
  console.error('诊断失败：', e.message);
  process.exit(1);
});
