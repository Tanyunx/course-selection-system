#!/usr/bin/env bash
# ---------------------------------------------------------------
# 本地开发用 PostgreSQL 初始化脚本
#
# 作用：
#   1. 生成应用数据库账号口令，写入 backend/.env（已 gitignore，不进版本库）
#   2. 创建应用账号与数据库（已存在则跳过）
#   3. 以应用账号身份导入 backend/src/main/resources/db/schema-pg.sql
#
# 依赖：本地 PostgreSQL 实例（可使用官方安装器、发行版包管理器，
#       或工程内自带的免安装便携版）
#       默认监听 127.0.0.1:55432，超级用户 postgres
#
# 可用环境变量覆盖（都有合理默认值，通常无需设置）：
#   PGROOT     PostgreSQL 根目录（其下应有 pgsql/bin 或 bin）
#   PGPORT     实例端口，默认 55432
#   PYTHON     用于生成随机口令的 Python 解释器
#
# 用法：bash tools/pg-setup.sh
# ---------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------- 0. 定位 PostgreSQL 与 Python ----------
# PostgreSQL 根目录：优先环境变量，其次工程内便携版，最后探常见安装位置
if [ -n "${PGROOT:-}" ]; then
  :
elif [ -d "$ROOT/.pgsql" ]; then
  PGROOT="$ROOT/.pgsql"
elif [ -d "$ROOT/tools/pgsql" ]; then
  PGROOT="$ROOT/tools/pgsql"
else
  PGROOT=""
fi

# bin 目录可能直接在 PGROOT 下，也可能在 PGROOT/pgsql 下（官方 zip 解压后的形态）
if [ -n "$PGROOT" ] && [ -d "$PGROOT/pgsql/bin" ]; then
  PGBIN="$PGROOT/pgsql/bin"
elif [ -n "$PGROOT" ] && [ -d "$PGROOT/bin" ]; then
  PGBIN="$PGROOT/bin"
elif command -v psql >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v psql)")"
else
  PGBIN=""
fi

PGPORT="${PGPORT:-55432}"
# 超级用户口令：优先环境变量，其次 PGROOT/superuser.pw
if [ -n "${PGSUPERPW:-}" ]; then
  SUPERPW="$PGSUPERPW"
elif [ -n "$PGROOT" ] && [ -f "$PGROOT/superuser.pw" ]; then
  SUPERPW="$(cat "$PGROOT/superuser.pw")"
else
  SUPERPW=""
fi

# Python：优先环境变量，其次 PATH，最后报错
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  if command -v python3 >/dev/null 2>&1; then PY="$(command -v python3)"
  elif command -v python >/dev/null 2>&1; then PY="$(command -v python)"
  else echo "[失败] 找不到 Python，请设置 PYTHON 环境变量指向解释器。" >&2; exit 1
  fi
fi

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
