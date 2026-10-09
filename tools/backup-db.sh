#!/usr/bin/env bash
# ---------------------------------------------------------------
# 数据库备份脚本（PostgreSQL / pg_dump 自定义格式）
#
# 作用：
#   把课程选课系统的数据库完整导出为一个 .dump 文件（pg_dump -Fc），
#   默认保存到 <项目>/backups/，文件名带时间戳，并自动清理旧备份。
#
# 特点：
#   - 读取 backend/.env 的连接信息，不把口令写在命令行（避免出现在进程列表）
#   - 自定义格式（-Fc）支持压缩与并行恢复，可用 pg_restore 选择性还原单表
#   - 同时导出一份纯文本 .sql 便于人工查看/比对（可用 --no-plain 关闭）
#   - 保留最近 KEEP 份，其余按时间顺序删除（可用 --keep N 调整）
#
# 用法：
#   bash tools/backup-db.sh                 # 备份到 backups/，保留最近 10 份
#   bash tools/backup-db.sh --keep 30       # 保留最近 30 份
#   bash tools/backup-db.sh --out /data/bak # 指定输出目录
#   bash tools/backup-db.sh --no-plain      # 只生成 .dump，不生成 .sql
#   bash tools/backup-db.sh --tag before-demo   # 文件名追加标记
#
# 定时备份（服务器上每天凌晨 3 点，示例）：
#   crontab -e
#   0 3 * * * cd /opt/course-selection-system && bash tools/backup-db.sh --keep 14 >> /var/log/course-backup.log 2>&1
#
# 恢复见 tools/restore-db.sh
# ---------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/backend/.env"

KEEP=10
OUTDIR="$ROOT/backups"
MAKE_PLAIN=1
TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)     KEEP="$2"; shift 2 ;;
    --out)      OUTDIR="$2"; shift 2 ;;
    --no-plain) MAKE_PLAIN=0; shift ;;
    --tag)      TAG="$2"; shift 2 ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[完成]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. 读取连接配置 ----------
[ -f "$ENVFILE" ] || die "找不到 $ENVFILE，请先执行 bash tools/pg-setup.sh"

# 只取键值，不打印口令（grep 出来的值全程只在变量里流转）
env_get() { grep -E "^$1=" "$ENVFILE" | head -1 | cut -d= -f2-; }

DB_HOST="$(env_get DB_HOST)"
DB_PORT="$(env_get DB_PORT)"
DB_NAME="$(env_get DB_NAME)"
DB_USER="$(env_get DB_USER)"
DB_PASSWORD="$(env_get DB_PASSWORD)"
export PGPASSWORD="$DB_PASSWORD"

[ -n "$DB_NAME" ] || die ".env 里缺少 DB_NAME"

# ---------- 2. 定位 pg_dump ----------
# 查找顺序：环境变量 PGBIN → PATH → 常见安装位置（含免安装便携版）
find_pg_bin() {
  local exe="$1"
  # ① 环境变量显式指定
  if [ -n "${PGBIN:-}" ] && { [ -x "${PGBIN}/${exe}" ] || [ -x "${PGBIN}/${exe}.exe" ]; }; then
    [ -x "${PGBIN}/${exe}.exe" ] && { echo "${PGBIN}/${exe}.exe"; return; }
    echo "${PGBIN}/${exe}"; return
  fi
  # ② 已在 PATH 里
  if command -v "$exe" >/dev/null 2>&1; then command -v "$exe"; return; fi
  # ③ 常见安装位置（Windows 官方安装器 / 便携解压版 / macOS Homebrew / Linux 发行版）
  local cand
  for cand in \
    "/c/Program Files/PostgreSQL"/*/bin \
    "/c/Program Files (x86)/PostgreSQL"/*/bin \
    "$HOME/scoop/apps/postgresql/current/bin" \
    "/opt/homebrew/opt/postgresql"*/bin \
    "/usr/local/opt/postgresql"*/bin \
    "/usr/lib/postgresql"/*/bin \
    "/usr/pgsql-"*/bin ; do
    if [ -x "${cand}/${exe}" ]; then echo "${cand}/${exe}"; return; fi
    if [ -x "${cand}/${exe}.exe" ]; then echo "${cand}/${exe}.exe"; return; fi
  done
  # ④ 工程内自带的便携版（若有人把 PostgreSQL 解压到 tools/pgsql/）
  local local_bin
  for local_bin in "$(dirname "$0")"/../pgsql/bin "$(dirname "$0")"/../.pgsql/bin; do
    [ -x "${local_bin}/${exe}" ] && { echo "${local_bin}/${exe}"; return; }
    [ -x "${local_bin}/${exe}.exe" ] && { echo "${local_bin}/${exe}.exe"; return; }
  done
  return 1
}

DUMP="$(find_pg_bin pg_dump)" || die "找不到 pg_dump。请设置 PGBIN 指向 PostgreSQL 的 bin 目录，或把 psql/pg_dump 加入 PATH。"

log "使用 pg_dump：$DUMP"
log "目标数据库：$DB_NAME @ $DB_HOST:$DB_PORT（用户 $DB_USER）"

# ---------- 3. 连通性预检（免得备份到一半才发现连不上） ----------
PSQL_BIN="$(find_pg_bin psql)" || PSQL_BIN=""
if [ -n "$PSQL_BIN" ]; then
  "$PSQL_BIN" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -tAc 'SELECT 1' >/dev/null 2>&1 \
    || die "无法连接数据库，请确认 PostgreSQL 实例已启动，且 .env 里的连接信息正确"
  ok "数据库连接正常"
fi

# ---------- 4. 执行备份 ----------
mkdir -p "$OUTDIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BASENAME="${DB_NAME}-${STAMP}${TAG:+-$TAG}"

DUMPFILE="$OUTDIR/$BASENAME.dump"
log "导出中（自定义格式，含压缩）..."
"$DUMP" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -Fc --no-owner --no-privileges -f "$DUMPFILE" \
  || die "pg_dump 失败"

DUMP_SIZE="$(du -h "$DUMPFILE" 2>/dev/null | cut -f1)"
ok "已生成 $DUMPFILE（$DUMP_SIZE）"

if [ "$MAKE_PLAIN" = "1" ]; then
  SQLFILE="$OUTDIR/$BASENAME.sql"
  log "导出纯文本 SQL（便于人工查看与比对）..."
  "$DUMP" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges -f "$SQLFILE" \
    || die "pg_dump（纯文本）失败"
  SQL_SIZE="$(du -h "$SQLFILE" 2>/dev/null | cut -f1)"
  ok "已生成 $SQLFILE（$SQL_SIZE）"
fi

# ---------- 5. 清理旧备份 ----------
# 只清理本脚本命名规则（<库名>-<时间戳>*.dump/.sql）的文件，避免误删他人文件
log "保留最近 $KEEP 份，清理更早的备份..."
COUNT=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  COUNT=$((COUNT + 1))
  if [ "$COUNT" -gt "$KEEP" ]; then
    rm -f -- "$f"
    # 同名的 .sql 一并删除
    case "$f" in
      *.dump) rm -f -- "${f%.dump}.sql" ;;
    esac
  fi
done < <(ls -1t "$OUTDIR/$DB_NAME-"*.dump 2>/dev/null || true)

REMAIN="$(ls -1 "$OUTDIR/$DB_NAME-"*.dump 2>/dev/null | wc -l | tr -d ' ')"
ok "当前保留 $REMAIN 份备份"

echo
echo "备份完成。恢复方式："
echo "  bash tools/restore-db.sh $DUMPFILE"
