-- =============================================================
--  在线选课系统 种子数据
--  密码占位符 __PWD_HASH__ 由 scripts/init-db.js 在导入前替换
--  演示账号统一密码：123456
-- =============================================================

USE `course_selection`;
SET NAMES utf8mb4;

-- ---------- 学期 ----------
INSERT INTO `t_term` (`id`,`term_code`,`name`,`start_date`,`end_date`,`is_current`) VALUES
 (1,'2025-2026-2','2025-2026 学年第二学期','2026-02-23','2026-07-10',0),
 (2,'2026-2027-1','2026-2027 学年第一学期','2026-09-07','2027-01-15',1);

-- ---------- 用户 ----------
INSERT INTO `t_user` (`id`,`username`,`password_hash`,`real_name`,`role`,`status`) VALUES
 (1,'sysadmin',  '__PWD_HASH__','孙运维',4,1),
 (2,'academic',  '__PWD_HASH__','周教务',3,1),
 (3,'teacher001','__PWD_HASH__','张明远',2,1),
 (4,'teacher002','__PWD_HASH__','李佳琪',2,1),
 (5,'teacher003','__PWD_HASH__','王建国',2,1),
 (6,'teacher004','__PWD_HASH__','赵雪',  2,1),
 (7,'2024001',   '__PWD_HASH__','陈嘉禾',1,1),
 (8,'2024002',   '__PWD_HASH__','林知遥',1,1),
 (9,'2024003',   '__PWD_HASH__','吴子墨',1,1),
 (10,'2023001',  '__PWD_HASH__','黄一诺',1,1),
 (11,'2023002',  '__PWD_HASH__','徐念安',1,1),
 (12,'2023003',  '__PWD_HASH__','何书宁',1,1),
 (13,'2025001',  '__PWD_HASH__','郑亦然',1,1),
 (14,'2025002',  '__PWD_HASH__','沈听澜',1,1);

-- ---------- 学生 ----------
INSERT INTO `t_student` (`id`,`user_id`,`student_no`,`grade`,`college`,`major`) VALUES
 (1,  7,'2024001','2024','计算机学院','软件工程'),
 (2,  8,'2024002','2024','计算机学院','计算机科学与技术'),
 (3,  9,'2024003','2024','外国语学院','英语'),
 (4, 10,'2023001','2023','计算机学院','软件工程'),
 (5, 11,'2023002','2023','计算机学院','人工智能'),
 (6, 12,'2023003','2023','经济管理学院','工商管理'),
 (7, 13,'2025001','2025','计算机学院','软件工程'),
 (8, 14,'2025002','2025','数学学院','应用数学');

-- ---------- 教师 ----------
INSERT INTO `t_teacher` (`id`,`user_id`,`teacher_no`,`college`,`title`) VALUES
 (1,3,'T1001','数学学院','教授'),
 (2,4,'T1002','外国语学院','副教授'),
 (3,5,'T1003','计算机学院','教授'),
 (4,6,'T1004','计算机学院','讲师');

-- ---------- 课程类别 ----------
INSERT INTO `t_course_category` (`id`,`code`,`name`) VALUES
 (1,'GEN','通识课'),
 (2,'MAJ','专业课'),
 (3,'ELE','选修课');

-- ---------- 课程目录 ----------
INSERT INTO `t_course` (`id`,`course_code`,`name`,`category_id`,`credit`,`dept`,`description`) VALUES
 (1,'MATH1001','高等数学（上）',2,4.0,'数学学院','微积分基础，极限、导数与积分为核心内容。'),
 (2,'MATH2002','线性代数',       2,3.0,'数学学院','矩阵、向量空间与线性变换。'),
 (3,'CS1001',  '程序设计基础',   2,4.0,'计算机学院','面向过程与面向对象程序设计入门。'),
 (4,'CS2001',  '数据结构',       2,4.0,'计算机学院','线性表、树、图与常用算法。'),
 (5,'CS2002',  '操作系统',       2,3.0,'计算机学院','进程、内存、文件系统与并发控制。'),
 (6,'CS3001',  '数据库系统原理', 2,3.0,'计算机学院','关系模型、SQL、事务与索引。'),
 (7,'CS3002',  '计算机网络',     2,3.0,'计算机学院','TCP/IP 协议栈与网络编程。'),
 (8,'CS3003',  'Web 应用开发',   2,3.0,'计算机学院','前后端分离架构与 REST 接口设计。'),
 (9,'ENG1001', '大学英语（一）', 1,3.0,'外国语学院','听说读写综合训练。'),
 (10,'GEN2001','中国近现代史纲要',1,2.0,'马克思主义学院','历史脉络与理论演进。'),
 (11,'ELE1001','音乐鉴赏',       3,1.0,'艺术学院','中外经典音乐作品赏析。'),
 (12,'ELE1002','创新创业基础',   3,2.0,'经济管理学院','创业思维与商业计划实践。'),
 (13,'STAT2001','概率论与数理统计',2,3.0,'数学学院','随机变量、分布与统计推断。'),
 (14,'ELE1003','羽毛球（体育）', 3,1.0,'体育部','基础技术与对抗训练。'),
 (15,'ENG2001','学术英语写作',   1,2.0,'外国语学院','学术论文写作规范。'),
 (16,'CS4001', '人工智能导论',   2,3.0,'计算机学院','搜索、机器学习与神经网络基础。');

-- ---------- 先修关系 ----------
-- 数据结构 需要【程序设计基础】
INSERT INTO `t_course_prereq` (`course_id`,`prereq_course_id`,`require_type`,`group_no`) VALUES
 (4,3,1,1);
-- 操作系统 需要【数据结构】与【程序设计基础】（与关系）
INSERT INTO `t_course_prereq` (`course_id`,`prereq_course_id`,`require_type`,`group_no`) VALUES
 (5,4,1,1),(5,3,1,2);
-- 数据库系统原理 需要【数据结构】或【程序设计基础】（或关系）
INSERT INTO `t_course_prereq` (`course_id`,`prereq_course_id`,`require_type`,`group_no`) VALUES
 (6,4,2,1),(6,3,2,1);
-- 人工智能导论 需要【线性代数】与【概率论与数理统计】
INSERT INTO `t_course_prereq` (`course_id`,`prereq_course_id`,`require_type`,`group_no`) VALUES
 (16,2,1,1),(16,13,1,2);

-- ---------- 开课（2026-2027-1） ----------
INSERT INTO `t_course_offering` (`id`,`course_id`,`term_id`,`teacher_id`,`capacity`,`enrolled`,`status`,`campus`,`remark`) VALUES
 (1, 1,2,1,60,0,1,'东校区','数学基础课，建议一年级修读'),
 (2, 2,2,1,50,0,1,'东校区',NULL),
 (3, 3,2,3,45,0,1,'东校区','需要上机实验'),
 (4, 4,2,3,40,0,1,'东校区','核心专业课'),
 (5, 5,2,4,40,0,1,'东校区',NULL),
 (6, 6,2,3,50,0,1,'东校区',NULL),
 (7, 7,2,4,45,0,1,'东校区',NULL),
 (8, 8,2,4,35,0,1,'东校区','项目驱动教学'),
 (9, 9,2,2,55,0,1,'西校区',NULL),
 (10,10,2,2,80,0,1,'西校区',NULL),
 (11,11,2,2,120,0,1,'东校区','公共选修，教室容量有限'),
 (12,12,2,1,60,0,1,'东校区',NULL),
 (13,13,2,1,50,0,1,'东校区',NULL),
 (14,14,2,4,30,0,1,'体育馆',NULL),
 (15,15,2,2,35,0,1,'西校区',NULL),
 (16,16,2,3,30,0,1,'东校区','热门课程，名额紧张');

-- ---------- 排课 ----------
INSERT INTO `t_course_schedule` (`offering_id`,`weekday`,`start_period`,`end_period`,`parity`,`campus`,`building`,`room`) VALUES
 (1, 1,1,2,0,'东校区','第一教学楼','A101'),
 (1, 3,3,4,0,'东校区','第一教学楼','A101'),
 (2, 2,3,4,0,'东校区','第一教学楼','A203'),
 (3, 1,3,4,0,'东校区','实验楼','B201'),
 (3, 4,5,6,0,'东校区','实验楼','机房3'),
 (4, 2,1,2,0,'东校区','第二教学楼','C305'),
 (4, 5,3,4,0,'东校区','第二教学楼','C305'),
 (5, 2,1,2,0,'东校区','第二教学楼','C201'),
 (5, 4,5,6,0,'东校区','第二教学楼','C201'),
 (6, 3,1,2,0,'东校区','第二教学楼','C102'),
 (7, 4,1,2,0,'东校区','第二教学楼','C208'),
 (8, 5,1,2,0,'东校区','实验楼','机房5'),
 (9, 2,5,6,0,'西校区','外语楼','D301'),
 (10,4,3,4,0,'西校区','文科楼','E102'),
 (11,3,7,8,0,'东校区','艺术楼','F201'),
 (12,5,7,8,0,'东校区','经济楼','G101'),
 (13,2,7,8,0,'东校区','第一教学楼','A305'),
 (14,5,5,6,0,'东校区','体育馆','羽毛球场'),
 (15,4,7,8,0,'西校区','外语楼','D205'),
 (16,1,5,6,0,'东校区','第二教学楼','C401'),
 (16,3,5,6,1,'东校区','第二教学楼','C401');

-- ---------- 选课批次（以导入当天为基准，覆盖近 60 天） ----------
INSERT INTO `t_enroll_batch` (`id`,`term_id`,`name`,`type`,`start_time`,`end_time`,`target_grade`,`target_college`,`priority`,`status`) VALUES
 (1,2,'2023 级高年级优先批次',1, DATE_SUB(NOW(), INTERVAL 30 DAY), DATE_ADD(NOW(), INTERVAL 30 DAY),'2023',NULL,1,1),
 (2,2,'2024 级正常选课批次',  1, DATE_SUB(NOW(), INTERVAL 20 DAY), DATE_ADD(NOW(), INTERVAL 40 DAY),'2024',NULL,2,1),
 (3,2,'2025 级正常选课批次',  1, DATE_SUB(NOW(), INTERVAL 10 DAY), DATE_ADD(NOW(), INTERVAL 50 DAY),'2025',NULL,3,1),
 (4,2,'全校补退选批次',       2, DATE_SUB(NOW(), INTERVAL 5 DAY),  DATE_ADD(NOW(), INTERVAL 60 DAY),NULL,NULL,4,1);

-- ---------- 学分规则 ----------
INSERT INTO `t_credit_rule` (`term_id`,`grade`,`min_credit`,`max_credit`) VALUES
 (2,'2023',10.0,24.0),
 (2,'2024',10.0,24.0),
 (2,'2025',10.0,20.0);

-- ---------- 类别学分要求 ----------
INSERT INTO `t_category_credit_rule` (`term_id`,`category_id`,`min_credit`,`max_credit`) VALUES
 (2,1,6.0,NULL),
 (2,2,12.0,NULL),
 (2,3,NULL,6.0);

-- ---------- 学生已修课程（用于先修校验） ----------
INSERT INTO `t_student_course_history` (`student_id`,`course_id`,`term_id`,`score`,`is_passed`) VALUES
 (1,3,1,88.0,1),(1,1,1,82.0,1),
 (2,3,1,76.0,1),(2,9,1,90.0,1),
 (3,9,1,85.0,1),
 (4,3,1,91.0,1),(4,4,1,87.0,1),(4,2,1,79.0,1),
 (5,3,1,93.0,1),(5,1,1,88.0,1),(5,2,1,84.0,1),(5,13,1,90.0,1),
 (6,9,1,80.0,1),
 (7,9,1,72.0,0),
 (8,1,1,86.0,1);

-- ---------- 历史选课记录（构造热度与"已选"场景） ----------
INSERT INTO `t_enrollment` (`student_id`,`offering_id`,`select_time`,`status`,`source`) VALUES
 (1, 1, DATE_SUB(NOW(), INTERVAL 3 DAY), 1,1),
 (1, 4, DATE_SUB(NOW(), INTERVAL 3 DAY), 1,1),
 (2, 1, DATE_SUB(NOW(), INTERVAL 3 DAY), 1,1),
 (2, 7, DATE_SUB(NOW(), INTERVAL 2 DAY), 1,1),
 (3, 9, DATE_SUB(NOW(), INTERVAL 2 DAY), 1,1),
 (4, 1, DATE_SUB(NOW(), INTERVAL 4 DAY), 1,1),
 (4, 5, DATE_SUB(NOW(), INTERVAL 4 DAY), 1,1),
 (4, 6, DATE_SUB(NOW(), INTERVAL 3 DAY), 1,1),
 (5, 2, DATE_SUB(NOW(), INTERVAL 4 DAY), 1,1),
 (5, 16,DATE_SUB(NOW(), INTERVAL 4 DAY), 1,1),
 (6, 12,DATE_SUB(NOW(), INTERVAL 2 DAY), 1,1);

-- ---------- 候补记录 ----------
INSERT INTO `t_waitlist` (`student_id`,`offering_id`,`queue_no`,`join_time`,`status`) VALUES
 (2,16,1,DATE_SUB(NOW(), INTERVAL 1 DAY),1),
 (3,16,2,DATE_SUB(NOW(), INTERVAL 1 DAY),1),
 (1,16,3,DATE_SUB(NOW(), INTERVAL 12 HOUR),1);

-- ---------- 公告 ----------
INSERT INTO `t_announcement` (`publisher_id`,`title`,`content`,`target_scope`,`publish_time`,`status`) VALUES
 (2,'2026-2027 学年第一学期选课通知',
    '本轮选课自 9 月 7 日开放，按年级分批次进行：2023 级优先批次先开放，2024、2025 级依次开放，补退选批次统一开放。请同学们在批次时间窗口内完成选课，逾期系统将不再受理。',
    NULL, DATE_SUB(NOW(), INTERVAL 2 DAY), 1),
 (2,'关于时间冲突检测规则的说明',
    '系统按「星期 + 节次区间 + 单双周」三个维度检测冲突：同一星期、节次区间相交且单双周不互斥时判定为冲突。跨校区不作为冲突条件，但相邻节次分处不同校区会给出赶课时间紧张的提示。',
    NULL, DATE_SUB(NOW(), INTERVAL 1 DAY), 1);

-- ---------- 通知 ----------
INSERT INTO `t_notice` (`user_id`,`type`,`title`,`content`,`related_id`,`is_read`) VALUES
 (7,5,'新公告：2026-2027 学年第一学期选课通知','本轮选课自 9 月 7 日开放，按年级分批次进行，请在批次时间内完成选课。',1,0),
 (7,5,'新公告：关于时间冲突检测规则的说明','系统按星期、节次区间与单双周三个维度检测冲突。',2,0),
 (8,2,'候补递补提醒','你候补的《人工智能导论》已进入候补队列，当前排位第 1 位。',16,0);

-- ---------- 同步 enrolled 计数与开课状态（保证种子数据自洽） ----------
UPDATE `t_course_offering` o
SET o.enrolled = (SELECT COUNT(*) FROM `t_enrollment` e WHERE e.offering_id = o.id AND e.status = 1);

UPDATE `t_course_offering` SET `status` = 2 WHERE `enrolled` >= `capacity`;
