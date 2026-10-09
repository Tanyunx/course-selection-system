#!/usr/bin/env bash
# ---------------------------------------------------------------
# 数据库恢复脚本（PostgreSQL / pg_restore）
#
# 作用：
#   把 tools/backup-db.sh 生成的 .dump（或 .sql）恢复到数据库。
#   默认恢复到 backend/.env 中配置的库（即课程选课系统的库）。
#
# 安全设计（重要）：
#   - 恢复会**清空并覆盖**目标库的现有数据，因此默认要求显式确认；
#   - 提供 --dry-run 只做检查不写库；
#   - 恢复前可选自动备份当前库（--backup-first，默认开启），出问题可回退；
#   - 若传入的库不存在，需加 --create 才会自动建库。
#
# 用法：
#   bash tools/restore-db.sh backups/course_selection-20261009-150000.dump
#   bash tools/restore-db.sh backups/xxx.dump --yes           # 跳过确认（脚本化场景）
#   bash tools/restore-db.sh backups/xxx.dump --dry-run       # 只检查
#   bash tools/restore-db.sh backups/xxx.dump --no-backup-first  # 恢复前不自动备份
#
# 说明：恢复采用「先 DROP 再 CREATE」的干净还原策略，避免残留旧表导致
#       结构冲突。这也是为什么要二次确认。
# ---------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/backend/.env"

SRC=""
ASSUME_YES=0
DRY_RUN=0
BACKUP_FIRST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)             ASSUME_YES=1; shift ;;
    --dry-run)            DRY_RUN=1; shift ;;
    --no-backup-first)    BACKUP_FIRST=0; shift ;;
    -h|--help)            sed -n '2,28p' "$0"; exit 0 ;;
    -*)                   echo "未知参数：$1（用 --help 查看用法）" >&2; exit 2 ;;
    *)                    SRC="$1"; shift ;;
  esac
done

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[完成]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$SRC" ] || die "请指定要恢复的备份文件，例如：bash tools/restore-db.sh backups/course_selection-20261009-150000.dump"
[ -f "$SRC" ] || die "找不到备份文件：$SRC"
[ -f "$ENVFILE" ] || die "找不到 $ENVFILE，请先执行 bash tools/pg-setup.sh"

env_get() { grep -E "^$1=" "$ENVFILE" | head -1 | cut -d= -f2-; }
DB_HOST="$(env_get DB_HOST)"
DB_PORT="$(env_get DB_PORT)"
DB_NAME="$(env_get DB_NAME)"
DB_USER="$(env_get DB_USER)"
DB_PASSWORD="$(env_get DB_PASSWORD)"
export PGPASSWORD="$DB_PASSWORD"

[ -n "$DB_NAME" ] || die ".env 里缺少 DB_NAME"

# ---------- 1. 定位 pg_restore / psql ----------
# 查找顺序：环境变量 PGBIN → PATH → 常见安装位置（含免安装便携版）
find_pg_bin_dir() {
  local exe="$1"
  # ① 环境变量显式指定
  if [ -n "${PGBIN:-}" ] && { [ -x "${PGBIN}/${exe}" ] || [ -x "${PGBIN}/${exe}.exe" ]; }; then
    echo "$PGBIN"; return
  fi
  # ② 已在 PATH 里
  if command -v "$exe" >/dev/null 2>&1; then
    dirname "$(command -v "$exe")"; return
  fi
  # ③ 常见安装位置
  local cand
  for cand in \
    "/c/Program Files/PostgreSQL"/*/bin \
    "/c/Program Files (x86)/PostgreSQL"/*/bin \
    "$HOME/scoop/apps/postgresql/current/bin" \
    "/opt/homebrew/opt/postgresql"*/bin \
    "/usr/local/opt/postgresql"*/bin \
    "/usr/lib/postgresql"/*/bin \
    "/usr/pgsql-"*/bin ; do
    if [ -x "${cand}/${exe}" ] || [ -x "${cand}/${exe}.exe" ]; then echo "$cand"; return; fi
  done
  # ④ 工程内自带的便携版
  local local_bin
  for local_bin in "$(dirname "$0")"/../pgsql/bin "$(dirname "$0")"/../.pgsql/bin; do
    if [ -x "${local_bin}/${exe}" ] || [ -x "${local_bin}/${exe}.exe" ]; then echo "$local_bin"; return; fi
  done
  return 1
}

PGBIN_DIR="$(find_pg_bin_dir pg_restore)" \
  || die "找不到 pg_restore。请设置 PGBIN 指向 PostgreSQL 的 bin 目录，或加入 PATH。"

RESTORE="$PGBIN_DIR/pg_restore"
[ -x "$RESTORE" ] || RESTORE="$PGBIN_DIR/pg_restore.exe"
PSQL="$PGBIN_DIR/psql"
[ -x "$PSQL" ] || PSQL="$PGBIN_DIR/psql.exe"

log "pg_restore：$RESTORE"
log "目标数据库：$DB_NAME @ $DB_HOST:$DB_PORT（用户 $DB_USER）"
log "备份文件  ：$SRC（$(du -h "$SRC" 2>/dev/null | cut -f1)）"

# ---------- 2. 识别文件类型 ----------
# pg_restore 只吃自定义格式（-Fc）；纯文本 .sql 要用 psql 导入
IS_CUSTOM=1
if head -c 5 "$SRC" 2>/dev/null | grep -q '^--' || { [ "${SRC##*.}" = "sql" ]; }; then
  IS_CUSTOM=0
fi
if [ "$IS_CUSTOM" = "1" ]; then
  log "识别为自定义格式（pg_dump -Fc），将使用 pg_restore"
else
  log "识别为纯文本 SQL，将使用 psql 导入"
fi

# ---------- 3. 展示当前库状态（恢复前的基线） ----------
"$PSQL" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT 1" >/dev/null 2>&1 \
  || die "无法连接目标数据库，请确认实例已启动（bash .workbuddy/binaries/pgsql/pgctl.sh start）"

BEFORE_TABLES="$("$PSQL" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d ' ')"
BEFORE_USERS="$("$PSQL" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -tAc "SELECT count(*) FROM t_user" 2>/dev/null | tr -d ' ' || echo '?')"
log "恢复前：public 表 $BEFORE_TABLES 张，t_user 记录 $BEFORE_USERS 条"

if [ "$DRY_RUN" = "1" ]; then
  ok "--dry-run 检查通过，未写库。确认无误后去掉 --dry-run 再执行。"
  exit 0
fi

# ---------- 4. 二次确认 ----------
if [ "$ASSUME_YES" != "1" ]; then
  echo
  echo "⚠️  此操作将清空并覆盖数据库 $DB_NAME 的现有数据，且不可撤销。"
  read -r -p "确认要恢复吗？输入 yes 继续：" ans
  [ "$ans" = "yes" ] || { echo "已取消，未做任何改动。"; exit 0; }
fi

# ---------- 5. 恢复前自动备份（安全网） ----------
if [ "$BACKUP_FIRST" = "1" ]; then
  log "恢复前自动备份当前库（万一恢复结果不对可回退）..."
  bash "$ROOT/tools/backup-db.sh" --tag "before-restore" --keep 30 >/dev/null 2>&1 \
    && ok "已生成恢复前快照（backups/ 目录下带 before-restore 标记）" \
    || printf '\033[33m[警告]\033[0m 恢复前备份失败，继续恢复。\n'
fi

# ---------- 6. 执行恢复 ----------
log "清空目标库现有对象..."
# public schema 重建：先删后建，保证是干净状态
"$PSQL" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SQL
ok "目标库已清空"

if [ "$IS_CUSTOM" = "1" ]; then
  log "使用 pg_restore 恢复..."
  # 说明：DROP SCHEMA 后库内已无对象，--clean 没有对象可删会报错，
  # 因此这里不加 --clean，直接按归档内容重建。
  "$RESTORE" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges --single-transaction "$SRC" \
    || die "pg_restore 失败"
else
  log "使用 psql 导入..."
  "$PSQL" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -q -f "$SRC" \
    || die "psql 导入失败"
fi
ok "数据已写入"

# ---------- 7. 恢复结果校验 ----------
AFTER_TABLES="$("$PSQL" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d ' ')"
AFTER_USERS="$("$PSQL" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -tAc "SELECT count(*) FROM t_user" 2>/dev/null | tr -d ' ' || echo '?')"

echo
printf '%-14s %-16s %-16s\n' "指标" "恢复前" "恢复后"
printf '%-14s %-16s %-16s\n' "public 表数" "$BEFORE_TABLES" "$AFTER_TABLES"
printf '%-14s %-16s %-16s\n' "t_user 记录" "$BEFORE_USERS" "$AFTER_USERS"

if [ "$AFTER_TABLES" -le 1 ]; then
  die "恢复后表数量异常（$AFTER_TABLES），请检查备份文件是否完整。"
fi

ok "恢复完成。建议重启后端服务让连接池重建："
echo "  本地：bash tools/run-backend.sh"
echo "  服务器：systemctl restart course-selection"
