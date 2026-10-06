#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MySQL 种子脚本 -> PostgreSQL 种子脚本 转换器。

用途：项目的演示数据最初写在 MySQL 方言的 db/seed.sql 中（legacy/node-backend/db/seed.sql），
后端迁移到 PostgreSQL 后需要一份等价脚本。人工重写容易漏数据，故用脚本做机械转换，
转换规则见 README「从 MySQL 迁移到 PostgreSQL」一节：

  1. 去掉反引号（PG 标识符小写即可，无保留字冲突）
  2. UPDATE `t` alias SET ...  ->  UPDATE t AS alias SET ...
  2b. SET alias.col = ...      ->  SET col = ...（PG 禁止在 SET 子句用别名限定）
  3. 去掉 MySQL 专有的 SET NAMES / ENGINE / CHARSET 语句
  4. DATE_ADD/DATE_SUB(x, INTERVAL n UNIT) -> (x ± INTERVAL 'n units')
  5. 语句末尾追加自增序列校正（种子脚本显式写入主键，序列必须跟到最大值）
  6. 其余（NOW()、字符串与日期字面量、多行 VALUES）两种方言一致，原样保留

用法：
  python tools/mysql2pg.py legacy/node-backend/db/seed.sql \
                           backend/src/main/resources/db/seed-pg.sql
"""

import io
import re
import sys

# 带自增主键 id 的表，导入后需要校正序列
TABLES_WITH_IDENTITY = [
    "t_term", "t_user", "t_student", "t_teacher", "t_course_category",
    "t_course", "t_course_prereq", "t_course_offering", "t_course_schedule",
    "t_enrollment", "t_waitlist", "t_enroll_batch", "t_credit_rule",
    "t_category_credit_rule", "t_student_course_history", "t_notice",
    "t_announcement", "t_audit_log",
]

HEADER = """-- =============================================================
--  在线选课系统 演示数据（PostgreSQL 版）
--
--  本文件由 tools/mysql2pg.py 从 legacy/node-backend/db/seed.sql 自动转换生成，
--  请勿手工修改；如需调整演示数据，改源文件后重新生成。
--
--  __PWD_HASH__ 为占位符，应用启动时（app.db.init-on-startup=true）
--  由 DbInitializer 替换成演示口令的 BCrypt 哈希，源码中不出现任何明文口令。
-- =============================================================

"""

FOOTER_TMPL = """
-- -------------------------------------------------------------
-- 校正自增序列：种子脚本显式写入了主键，必须把序列推到当前最大值之后，
-- 否则后续 INSERT 会撞上已有主键（等价于 MySQL 的 AUTO_INCREMENT 自动跟随）
-- -------------------------------------------------------------
{stmts}"""


def convert(sql: str) -> str:
    out = sql

    # 1) 去反引号
    out = out.replace("`", "")

    # 2) UPDATE t alias SET -> UPDATE t AS alias SET
    out = re.sub(
        r"\bUPDATE\s+(\w+)\s+(?!AS\b|SET\b)(\w+)(\s+SET\b)",
        r"UPDATE \1 AS \2\3",
        out,
        flags=re.I,
    )

    # 2b) PG 不允许在 SET 子句里用别名限定列名（MySQL 可以）：
    #     SET o.enrolled = ...  ->  SET enrolled = ...
    out = re.sub(r"\bSET\s+(\w+)\.", "SET ", out)

    # 3) 去掉 MySQL 专有语句
    out = re.sub(r"(?im)^\s*SET\s+NAMES\s+\S+\s*;\s*$", "", out)
    out = re.sub(r"(?ims)^\s*SET\s+FOREIGN_KEY_CHECKS\s*=\s*\d+\s*;\s*$", "", out)
    out = re.sub(r"(?im)^\s*USE\s+\S+\s*;\s*$", "", out)

    # 4) 日期函数：MySQL 的 DATE_ADD / DATE_SUB 在 PostgreSQL 中不存在，
    #    统一改写为标准 SQL 的"时间戳 ± INTERVAL"写法
    #      DATE_SUB(NOW(), INTERVAL 30 DAY) -> (NOW() - INTERVAL '30 days')
    #      DATE_ADD(NOW(), INTERVAL 1 HOUR) -> (NOW() + INTERVAL '1 hours')
    unit_map = {
        "DAY": "days", "HOUR": "hours", "MINUTE": "minutes",
        "SECOND": "seconds", "MONTH": "months", "YEAR": "years", "WEEK": "weeks",
    }

    def sub_interval(m: "re.Match") -> str:
        base, num, unit = m.group(1).strip(), m.group(2), m.group(3).upper()
        return "(%s - INTERVAL '%s %s')" % (base, num, unit_map.get(unit, unit.lower()))

    def add_interval(m: "re.Match") -> str:
        base, num, unit = m.group(1).strip(), m.group(2), m.group(3).upper()
        return "(%s + INTERVAL '%s %s')" % (base, num, unit_map.get(unit, unit.lower()))

    out = re.sub(
        r"DATE_SUB\(\s*([^,()]+(?:\(\))?)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*\)",
        sub_interval, out, flags=re.I,
    )
    out = re.sub(
        r"DATE_ADD\(\s*([^,()]+(?:\(\))?)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*\)",
        add_interval, out, flags=re.I,
    )

    # 压缩 3 行以上连续空行
    out = re.sub(r"\n{3,}", "\n\n", out)

    return out.strip()


def footer() -> str:
    stmts = []
    for t in TABLES_WITH_IDENTITY:
        stmts.append(
            "SELECT setval(pg_get_serial_sequence('{t}', 'id'),\n"
            "              COALESCE((SELECT MAX(id) FROM {t}), 1));".format(t=t)
        )
    return FOOTER_TMPL.format(stmts="\n".join(stmts))


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    with io.open(src, encoding="utf-8") as f:
        raw = f.read()

    # 源文件开头的 MySQL 注释块保留为注释更好追溯，但里面可能含 MySQL 专有说明，
    # 这里只截取第一条语句之后的内容体，统一用新的文件头。
    body = convert(raw)

    with io.open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(HEADER)
        f.write(body)
        f.write("\n")
        f.write(footer())
        f.write("\n")

    print("已生成: %s (%d 字符)" % (dst, len(HEADER) + len(body) + len(footer())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
