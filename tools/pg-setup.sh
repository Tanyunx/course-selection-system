#!/usr/bin/env bash
# ---------------------------------------------------------------
# 本地开发用 PostgreSQL 初始化脚本
#
# 作用：
#   1. 生成应用数据库账号口令，写入 backend/.env（已 gitignore，不进版本库）
#   2. 创建应用账号与数据库（已存在则跳过）
#   3. 以应用账号身份导入 backend/src/main/resources/db/schema-pg.sql
#
# 依赖：本地免安装 PostgreSQL 实例（见 .workbuddy/binaries/pgsql/pgctl.sh）
#      默认监听 127.0.0.1:55432，超级用户 postgres
#
# 用法：bash tools/pg-setup.sh
# ---------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGROOT="C:/Users/TAN30/.workbuddy/binaries/pgsql"
PGBIN="$PGROOT/pgsql/bin"
PGPORT=55432
SUPERPW="$(cat "$PGROOT/superuser.pw")"
PY="C:/Users/TAN30/.workbuddy/binaries/python/versions/3.13.12/python.exe"

ENVFILE="$ROOT/backend/.env"
DB_NAME="course_selection"
DB_USER="course_app"

# ---------- 1. 生成 .env（首行口令随机，不回显） ----------
if [ ! -f "$ENVFILE" ]; then
  "$PY" - "$ENVFILE" "$DB_NAME" "$DB_USER" <<'PY'
import io, secrets, sys
path, db, user = sys.argv[1], sys.argv[2], sys.argv[3]
lines = [
    "# 本地开发环境数据库连接配置（由 tools/pg-setup.sh 生成，已被 .gitignore 排除）",
    "DB_HOST=127.0.0.1",
    "DB_PORT=55432",
    "DB_NAME=%s" % db,
    "DB_USER=%s" % user,
    "DB_PASSWORD=%s" % secrets.token_urlsafe(24),
    "",
]
io.open(path, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
print("已生成 %s（口令已随机生成，不回显）" % path)
PY
else
  echo "复用已有 $ENVFILE"
fi

APP_PW="$(grep -E '^DB_PASSWORD=' "$ENVFILE" | head -1 | cut -d= -f2-)"

# ---------- 2. 创建账号与数据库 ----------
# 说明：PostgreSQL 15 起 public schema 归 pg_database_owner 所有，
# 数据库属主才拥有建表权限，因此这里必须把库与 schema 的属主一并校正为应用账号，
# 否则导入结构会报 "permission denied for schema public"。
echo "创建应用账号与数据库（已存在则跳过，属主会被校正）..."
PGPASSWORD="$SUPERPW" "$PGBIN/psql.exe" -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -q \
  -v pw="$APP_PW" -v db="$DB_NAME" -v usr="$DB_USER" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'usr', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'usr') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8''', :'db', :'usr')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'usr') \gexec
SQL

PGPASSWORD="$SUPERPW" "$PGBIN/psql.exe" -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 -q \
  -v usr="$DB_USER" <<'SQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'usr') \gexec
SQL

# ---------- 3. 以应用账号导入结构 ----------
echo "导入 schema-pg.sql ..."
PGPASSWORD="$APP_PW" "$PGBIN/psql.exe" -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 -q -f "$ROOT/backend/src/main/resources/db/schema-pg.sql"

echo "表数量：$(PGPASSWORD="$APP_PW" "$PGBIN/psql.exe" -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
echo "完成。"
