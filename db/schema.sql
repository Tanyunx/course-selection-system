-- =============================================================
--  在线选课系统 数据库结构脚本
--  对应《选课系统系统设计文档（优化版 V3.0）》第 5 章
--  MySQL 8.0 / InnoDB / utf8mb4
-- =============================================================

CREATE DATABASE IF NOT EXISTS `course_selection`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `course_selection`;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `t_audit_log`;
DROP TABLE IF EXISTS `t_announcement`;
DROP TABLE IF EXISTS `t_notice`;
DROP TABLE IF EXISTS `t_student_course_history`;
DROP TABLE IF EXISTS `t_category_credit_rule`;
DROP TABLE IF EXISTS `t_credit_rule`;
DROP TABLE IF EXISTS `t_enroll_batch`;
DROP TABLE IF EXISTS `t_waitlist`;
DROP TABLE IF EXISTS `t_enrollment`;
DROP TABLE IF EXISTS `t_course_schedule`;
DROP TABLE IF EXISTS `t_course_offering`;
DROP TABLE IF EXISTS `t_course_prereq`;
DROP TABLE IF EXISTS `t_course`;
DROP TABLE IF EXISTS `t_course_category`;
DROP TABLE IF EXISTS `t_teacher`;
DROP TABLE IF EXISTS `t_student`;
DROP TABLE IF EXISTS `t_user`;
DROP TABLE IF EXISTS `t_term`;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- 1. t_term 学期
-- -------------------------------------------------------------
CREATE TABLE `t_term` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '学期主键',
  `term_code`  VARCHAR(20)  NOT NULL                COMMENT '学期编码，如 2026-2027-1',
  `name`       VARCHAR(50)  NOT NULL                COMMENT '学期名称',
  `start_date` DATE         NOT NULL                COMMENT '学期开始日期',
  `end_date`   DATE         NOT NULL                COMMENT '学期结束日期',
  `is_current` TINYINT      NOT NULL DEFAULT 0      COMMENT '是否当前学期 0否 1是',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_term_code` (`term_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学期';

-- -------------------------------------------------------------
-- 2. t_user 用户（认证与身份）
-- -------------------------------------------------------------
CREATE TABLE `t_user` (
  `id`            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '用户主键',
  `username`      VARCHAR(50)  NOT NULL                COMMENT '登录账号',
  `password_hash` VARCHAR(100) NOT NULL                COMMENT '密码加盐哈希',
  `real_name`     VARCHAR(50)  NOT NULL                COMMENT '姓名',
  `role`          TINYINT      NOT NULL                COMMENT '角色 1学生 2教师 3教务管理员 4系统管理员',
  `status`        TINYINT      NOT NULL DEFAULT 1      COMMENT '状态 0禁用 1正常',
  `last_login_at` DATETIME     NULL                    COMMENT '最后登录时间',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`),
  KEY `idx_user_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户';

-- -------------------------------------------------------------
-- 3. t_student 学生扩展信息
-- -------------------------------------------------------------
CREATE TABLE `t_student` (
  `id`         BIGINT      NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`    BIGINT      NOT NULL                COMMENT '关联用户',
  `student_no` VARCHAR(20) NOT NULL                COMMENT '学号',
  `grade`      VARCHAR(10) NOT NULL                COMMENT '年级',
  `college`    VARCHAR(50) NOT NULL                COMMENT '学院',
  `major`      VARCHAR(50) NULL                    COMMENT '专业',
  `created_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_student_user` (`user_id`),
  UNIQUE KEY `uk_student_no` (`student_no`),
  KEY `idx_student_grade` (`grade`),
  CONSTRAINT `fk_student_user` FOREIGN KEY (`user_id`) REFERENCES `t_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生';

-- -------------------------------------------------------------
-- 4. t_teacher 教师扩展信息
-- -------------------------------------------------------------
CREATE TABLE `t_teacher` (
  `id`         BIGINT      NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`    BIGINT      NOT NULL                COMMENT '关联用户',
  `teacher_no` VARCHAR(20) NOT NULL                COMMENT '工号',
  `college`    VARCHAR(50) NOT NULL                COMMENT '学院',
  `title`      VARCHAR(30) NULL                    COMMENT '职称',
  `created_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_teacher_user` (`user_id`),
  UNIQUE KEY `uk_teacher_no` (`teacher_no`),
  CONSTRAINT `fk_teacher_user` FOREIGN KEY (`user_id`) REFERENCES `t_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教师';

-- -------------------------------------------------------------
-- 5. t_course_category 课程类别
-- -------------------------------------------------------------
CREATE TABLE `t_course_category` (
  `id`         BIGINT      NOT NULL AUTO_INCREMENT COMMENT '主键',
  `code`       VARCHAR(20) NOT NULL                COMMENT '类别编码',
  `name`       VARCHAR(50) NOT NULL                COMMENT '类别名称',
  `created_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_category_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课程类别';

-- -------------------------------------------------------------
-- 6. t_course 课程目录
-- -------------------------------------------------------------
CREATE TABLE `t_course` (
  `id`          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '课程主键',
  `course_code` VARCHAR(20)  NOT NULL                COMMENT '课程代码',
  `name`        VARCHAR(100) NOT NULL                COMMENT '课程名称',
  `category_id` BIGINT       NOT NULL                COMMENT '课程类别',
  `credit`      DECIMAL(4,1) NOT NULL                COMMENT '学分',
  `dept`        VARCHAR(50)  NULL                    COMMENT '开课单位',
  `description` VARCHAR(500) NULL                    COMMENT '课程简介',
  `status`      TINYINT      NOT NULL DEFAULT 1      COMMENT '状态 0停用 1启用',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_course_code` (`course_code`),
  KEY `idx_course_name` (`name`),
  KEY `idx_course_category` (`category_id`),
  CONSTRAINT `fk_course_category` FOREIGN KEY (`category_id`) REFERENCES `t_course_category` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课程目录';

-- -------------------------------------------------------------
-- 7. t_course_prereq 课程先修关系
-- -------------------------------------------------------------
CREATE TABLE `t_course_prereq` (
  `id`               BIGINT  NOT NULL AUTO_INCREMENT COMMENT '主键',
  `course_id`        BIGINT  NOT NULL                COMMENT '课程',
  `prereq_course_id` BIGINT  NOT NULL                COMMENT '先修课程',
  `require_type`     TINYINT NOT NULL DEFAULT 1      COMMENT '1与(全部满足) 2或(满足其一)',
  `group_no`         INT     NOT NULL DEFAULT 1      COMMENT '或关系分组号，同组内满足其一即可',
  `created_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_course_prereq` (`course_id`, `prereq_course_id`),
  CONSTRAINT `fk_prereq_course` FOREIGN KEY (`course_id`) REFERENCES `t_course` (`id`),
  CONSTRAINT `fk_prereq_prereq` FOREIGN KEY (`prereq_course_id`) REFERENCES `t_course` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='课程先修关系';

-- -------------------------------------------------------------
-- 8. t_course_offering 学期开课
-- -------------------------------------------------------------
CREATE TABLE `t_course_offering` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '开课主键',
  `course_id`  BIGINT       NOT NULL                COMMENT '课程',
  `term_id`    BIGINT       NOT NULL                COMMENT '学期',
  `teacher_id` BIGINT       NOT NULL                COMMENT '授课教师',
  `capacity`   INT          NOT NULL                COMMENT '容量上限',
  `enrolled`   INT          NOT NULL DEFAULT 0      COMMENT '已选人数（权威计数）',
  `status`     TINYINT      NOT NULL DEFAULT 1      COMMENT '0停开 1开放 2已满',
  `campus`     VARCHAR(50)  NULL                    COMMENT '开课校区',
  `remark`     VARCHAR(200) NULL                    COMMENT '备注',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_course_term_teacher` (`course_id`, `term_id`, `teacher_id`),
  KEY `idx_offering_term_status` (`term_id`, `status`),
  KEY `idx_offering_teacher` (`teacher_id`),
  CONSTRAINT `fk_offering_course`  FOREIGN KEY (`course_id`)  REFERENCES `t_course` (`id`),
  CONSTRAINT `fk_offering_term`    FOREIGN KEY (`term_id`)    REFERENCES `t_term` (`id`),
  CONSTRAINT `fk_offering_teacher` FOREIGN KEY (`teacher_id`) REFERENCES `t_teacher` (`id`),
  CONSTRAINT `ck_offering_enrolled` CHECK (`enrolled` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学期开课';

-- -------------------------------------------------------------
-- 9. t_course_schedule 开课排课时段
-- -------------------------------------------------------------
CREATE TABLE `t_course_schedule` (
  `id`           BIGINT      NOT NULL AUTO_INCREMENT COMMENT '主键',
  `offering_id`  BIGINT      NOT NULL                COMMENT '所属开课',
  `weekday`      TINYINT     NOT NULL                COMMENT '星期 1周一至7周日',
  `start_period` TINYINT     NOT NULL                COMMENT '起始节次',
  `end_period`   TINYINT     NOT NULL                COMMENT '结束节次',
  `parity`       TINYINT     NOT NULL DEFAULT 0      COMMENT '0全周 1单周 2双周',
  `campus`       VARCHAR(50) NULL                    COMMENT '校区',
  `building`     VARCHAR(50) NULL                    COMMENT '教学楼',
  `room`         VARCHAR(50) NULL                    COMMENT '教室',
  `created_at`   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_schedule_offering` (`offering_id`),
  CONSTRAINT `fk_schedule_offering` FOREIGN KEY (`offering_id`) REFERENCES `t_course_offering` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='开课排课时段';

-- -------------------------------------------------------------
-- 10. t_enrollment 选课记录
-- -------------------------------------------------------------
CREATE TABLE `t_enrollment` (
  `id`          BIGINT   NOT NULL AUTO_INCREMENT COMMENT '主键',
  `student_id`  BIGINT   NOT NULL                COMMENT '学生',
  `offering_id` BIGINT   NOT NULL                COMMENT '开课',
  `select_time` DATETIME NOT NULL                COMMENT '选课时间（先到先得判定依据）',
  `status`      TINYINT  NOT NULL DEFAULT 1      COMMENT '0已退 1已选',
  `source`      TINYINT  NOT NULL DEFAULT 1      COMMENT '1正常选课 2候补递补',
  `drop_time`   DATETIME NULL                    COMMENT '退课时间',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_student_offering` (`student_id`, `offering_id`),
  KEY `idx_student_status` (`student_id`, `status`),
  KEY `idx_offering_status` (`offering_id`, `status`),
  CONSTRAINT `fk_enroll_student`  FOREIGN KEY (`student_id`)  REFERENCES `t_student` (`id`),
  CONSTRAINT `fk_enroll_offering` FOREIGN KEY (`offering_id`) REFERENCES `t_course_offering` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='选课记录';

-- -------------------------------------------------------------
-- 11. t_waitlist 候补记录
-- -------------------------------------------------------------
CREATE TABLE `t_waitlist` (
  `id`          BIGINT   NOT NULL AUTO_INCREMENT COMMENT '主键',
  `student_id`  BIGINT   NOT NULL                COMMENT '学生',
  `offering_id` BIGINT   NOT NULL                COMMENT '开课',
  `queue_no`    INT      NOT NULL                COMMENT '候补排位',
  `join_time`   DATETIME NOT NULL                COMMENT '加入时间',
  `status`      TINYINT  NOT NULL DEFAULT 1      COMMENT '1候补中 2已递补 3已取消 4已失效',
  `expire_time` DATETIME NULL                    COMMENT '递补确认截止时间',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_student_offering` (`student_id`, `offering_id`),
  UNIQUE KEY `uk_offering_queue` (`offering_id`, `queue_no`),
  KEY `idx_waitlist_status` (`offering_id`, `status`),
  CONSTRAINT `fk_wait_student`  FOREIGN KEY (`student_id`)  REFERENCES `t_student` (`id`),
  CONSTRAINT `fk_wait_offering` FOREIGN KEY (`offering_id`) REFERENCES `t_course_offering` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='候补记录';

-- -------------------------------------------------------------
-- 12. t_enroll_batch 选课批次
-- -------------------------------------------------------------
CREATE TABLE `t_enroll_batch` (
  `id`             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `term_id`        BIGINT       NOT NULL                COMMENT '学期',
  `name`           VARCHAR(50)  NOT NULL                COMMENT '批次名称',
  `type`           TINYINT      NOT NULL                COMMENT '1正常选课 2补退选',
  `start_time`     DATETIME     NOT NULL                COMMENT '开始时间',
  `end_time`       DATETIME     NOT NULL                COMMENT '截止时间',
  `target_grade`   VARCHAR(50)  NULL                    COMMENT '目标年级，逗号分隔，空为不限',
  `target_college` VARCHAR(100) NULL                    COMMENT '目标学院，空为不限',
  `priority`       INT          NOT NULL DEFAULT 0      COMMENT '优先级，越小越优先',
  `status`         TINYINT      NOT NULL DEFAULT 1      COMMENT '0停用 1启用',
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_batch_term` (`term_id`, `status`),
  CONSTRAINT `fk_batch_term` FOREIGN KEY (`term_id`) REFERENCES `t_term` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='选课批次';

-- -------------------------------------------------------------
-- 13. t_credit_rule 学期学分上下限
-- -------------------------------------------------------------
CREATE TABLE `t_credit_rule` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `term_id`    BIGINT       NOT NULL                COMMENT '学期',
  `grade`      VARCHAR(10)  NOT NULL                COMMENT '年级',
  `min_credit` DECIMAL(4,1) NOT NULL DEFAULT 0      COMMENT '学分下限（仅预警）',
  `max_credit` DECIMAL(4,1) NOT NULL                COMMENT '学分上限（强制拦截）',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_term_grade` (`term_id`, `grade`),
  CONSTRAINT `fk_credit_term` FOREIGN KEY (`term_id`) REFERENCES `t_term` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学分规则';

-- -------------------------------------------------------------
-- 14. t_category_credit_rule 类别学分要求
-- -------------------------------------------------------------
CREATE TABLE `t_category_credit_rule` (
  `id`          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `term_id`     BIGINT       NOT NULL                COMMENT '学期',
  `category_id` BIGINT       NOT NULL                COMMENT '课程类别',
  `min_credit`  DECIMAL(4,1) NULL                    COMMENT '该类别最低学分',
  `max_credit`  DECIMAL(4,1) NULL                    COMMENT '该类别最高学分',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_term_category` (`term_id`, `category_id`),
  CONSTRAINT `fk_ccr_term`     FOREIGN KEY (`term_id`)     REFERENCES `t_term` (`id`),
  CONSTRAINT `fk_ccr_category` FOREIGN KEY (`category_id`) REFERENCES `t_course_category` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='类别学分要求';

-- -------------------------------------------------------------
-- 15. t_student_course_history 学生已修课程与成绩
-- -------------------------------------------------------------
CREATE TABLE `t_student_course_history` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `student_id` BIGINT       NOT NULL                COMMENT '学生',
  `course_id`  BIGINT       NOT NULL                COMMENT '课程',
  `term_id`    BIGINT       NULL                    COMMENT '修读学期',
  `score`      DECIMAL(5,1) NULL                    COMMENT '成绩',
  `is_passed`  TINYINT      NOT NULL DEFAULT 0      COMMENT '是否通过，用于先修校验',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_student_course` (`student_id`, `course_id`),
  KEY `idx_history_student` (`student_id`),
  CONSTRAINT `fk_history_student` FOREIGN KEY (`student_id`) REFERENCES `t_student` (`id`),
  CONSTRAINT `fk_history_course`  FOREIGN KEY (`course_id`)  REFERENCES `t_course` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生已修课程与成绩';

-- -------------------------------------------------------------
-- 16. t_notice 个人通知
-- -------------------------------------------------------------
CREATE TABLE `t_notice` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`    BIGINT       NOT NULL                COMMENT '接收人',
  `type`       TINYINT      NOT NULL                COMMENT '1选课结果 2候补递补 3递补失败 4退课 5公告',
  `title`      VARCHAR(100) NOT NULL                COMMENT '标题',
  `content`    VARCHAR(500) NOT NULL                COMMENT '内容',
  `related_id` BIGINT       NULL                    COMMENT '关联业务主键',
  `is_read`    TINYINT      NOT NULL DEFAULT 0      COMMENT '是否已读',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notice_user` (`user_id`, `is_read`),
  CONSTRAINT `fk_notice_user` FOREIGN KEY (`user_id`) REFERENCES `t_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='个人通知';

-- -------------------------------------------------------------
-- 17. t_announcement 公告
-- -------------------------------------------------------------
CREATE TABLE `t_announcement` (
  `id`           BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `publisher_id` BIGINT       NOT NULL                COMMENT '发布人',
  `title`        VARCHAR(100) NOT NULL                COMMENT '公告标题',
  `content`      TEXT         NOT NULL                COMMENT '公告正文',
  `target_scope` VARCHAR(100) NULL                    COMMENT '投递范围，空为全体',
  `publish_time` DATETIME     NOT NULL                COMMENT '发布时间',
  `status`       TINYINT      NOT NULL DEFAULT 1      COMMENT '0草稿 1已发布 2已下架',
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_announce_status` (`status`, `publish_time`),
  CONSTRAINT `fk_announce_publisher` FOREIGN KEY (`publisher_id`) REFERENCES `t_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公告';

-- -------------------------------------------------------------
-- 18. t_audit_log 审计日志
-- -------------------------------------------------------------
CREATE TABLE `t_audit_log` (
  `id`          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`     BIGINT       NULL                    COMMENT '操作人',
  `username`    VARCHAR(50)  NULL                    COMMENT '操作人账号快照',
  `action`      VARCHAR(50)  NOT NULL                COMMENT '操作类型',
  `target_type` VARCHAR(30)  NULL                    COMMENT '目标对象类型',
  `target_id`   BIGINT       NULL                    COMMENT '目标对象主键',
  `ip`          VARCHAR(45)  NULL                    COMMENT '来源 IP',
  `result`      TINYINT      NOT NULL                COMMENT '0失败 1成功',
  `detail`      VARCHAR(500) NULL                    COMMENT '详情，含失败原因',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_user_time` (`user_id`, `created_at`),
  KEY `idx_audit_action` (`action`),
  KEY `idx_audit_time` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计日志';
