#!/usr/bin/env bash
#
# 选课系统 · 云服务器一键部署脚本
# 适用：Ubuntu 20.04 / 22.04 / 24.04 / 26.04（Debian 系同理）
#
# 用法（在服务器上、项目目录内执行）：
#   sudo bash deploy.sh                 # 完整部署（Node + MySQL + 应用 + pm2）
#   sudo bash deploy.sh --with-nginx    # 额外装 Nginx，用 80 端口访问（推荐）
#   sudo bash deploy.sh --skip-db-init  # 不重新初始化数据库（保留现有数据）
#
# 说明：脚本可重复执行，已装好的部分会自动跳过。
#

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_NAME="${DB_NAME:-course_selection}"
DB_USER="${DB_USER:-cs_app}"
APP_PORT="${PORT:-3000}"
PM2_NAME="course-selection"
NODE_MAJOR=22
WITH_NGINX=0
SKIP_DB_INIT=0

for arg in "$@"; do
  case "$arg" in
    --with-nginx)   WITH_NGINX=1 ;;
    --skip-db-init) SKIP_DB_INIT=1 ;;
    -h|--help)      sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（可用 --with-nginx / --skip-db-init）" >&2; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[注意]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# ---------------------------------------------------------------- 0. 前置检查

log "0/8 前置检查"

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy.sh"

command -v apt-get >/dev/null 2>&1 || die "本脚本只支持 Debian/Ubuntu 系（apt-get 不存在）"

[ -f "$APP_DIR/server/app.js" ] || die "没找到 server/app.js，请确认脚本放在项目根目录（当前：$APP_DIR）"

[ -f "$APP_DIR/db/schema.sql" ] || die "没找到 db/schema.sql，项目文件不完整"

ok "root 权限、Debian 系、项目文件齐全"

# ---------------------------------------------------------------- 1. 系统组件

log "1/8 更新软件源"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
ok "软件源已更新"

# ---------------------------------------------------------------- 2. Node.js

log "2/8 安装 Node.js ${NODE_MAJOR}"

NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CUR_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$CUR_MAJOR" -ge 18 ]; then
    NEED_NODE=0
    ok "已安装 Node.js $(node -v)，跳过"
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  # NodeSource 对刚发布的新版 Ubuntu 可能还没适配（如 26.04），失败则回退系统源
  if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null; then
    apt-get install -y -qq nodejs
  else
    warn "NodeSource 暂不支持当前发行版，改用系统源自带的 Node.js"
    apt-get install -y -qq nodejs npm
  fi
  command -v node >/dev/null 2>&1 || die "Node.js 安装失败"
  command -v npm  >/dev/null 2>&1 || die "npm 缺失（pm2 需要它）"
  ok "Node.js $(node -v) 安装完成"
fi

# ---------------------------------------------------------------- 3. MySQL

log "3/8 安装 MySQL 8"

if ! command -v mysql >/dev/null 2>&1; then
  apt-get install -y -qq mysql-server
fi
systemctl enable --now mysql
ok "MySQL 已启动（$(mysql --version | awk '{print $3}')）"

# ---------------------------------------------------------------- 4. 口令

log "4/8 准备数据库口令"

if [ -z "${DB_PASSWORD:-}" ]; then
  echo "    要新建/更新数据库账号 ${DB_USER}，请为它设置一个口令。"
  echo "    （直接回车则由脚本生成一个随机强口令，稍后会显示出来，记得保存）"
  printf '    请输入口令：'
  read -rs DB_PASSWORD </dev/tty
  echo
  if [ -z "$DB_PASSWORD" ]; then
    DB_PASSWORD="$(gen_secret)"
    GENERATED_PW=1
    ok "已生成随机口令"
  else
    printf '    再输入一次确认：'
    read -rs DB_PASSWORD2 </dev/tty
    echo
    [ "$DB_PASSWORD" = "$DB_PASSWORD2" ] || die "两次输入的口令不一致"
    ok "口令已确认"
  fi
else
  ok "从环境变量 DB_PASSWORD 读取到口令"
fi

# 口令会被拼进 SQL 语句和 .env 文件，含这些字符会破坏转义，必须在写入前拦下
case "$DB_PASSWORD" in
  *"'"*|*'"'*|*'\'*|*'$'*|*'`'*)
    die "口令不能包含单引号、双引号、反斜杠、美元符号或反引号。
      这些字符会破坏 SQL 与 .env 的转义，导致部署后连不上数据库。
      请改用只含字母、数字、下划线和短横线的口令；或直接回车让脚本生成随机强口令。"
    ;;
esac

[ "${#DB_PASSWORD}" -ge 8 ] || warn "口令短于 8 位，建议换一个更长的（仅影响安全性，不影响部署）"

# ---------------------------------------------------------------- 5. 建库建号

log "5/8 创建数据库与专用账号"

mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
ok "数据库 ${DB_NAME}、账号 ${DB_USER}@localhost 就绪"

# ---------------------------------------------------------------- 6. .env

log "6/8 写入 .env"

if [ -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env" "$APP_DIR/.env.bak.$(date +%Y%m%d%H%M%S)"
  warn "已存在 .env，先备份为 .env.bak.* 再覆盖"
fi

cat > "$APP_DIR/.env" <<EOF
# 由 deploy.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 生成
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}
DB_POOL=10

# HOST 必须是 0.0.0.0，否则只有服务器本机能访问
PORT=${APP_PORT}
HOST=0.0.0.0

AUTH_SECRET=$(gen_secret)
AUTH_IDLE_MINUTES=30
AUTH_CAPTCHA_AFTER=5

RL_WINDOW_SECONDS=60
RL_SOFT_LIMIT=10
RL_HARD_LIMIT=20

IDEMPOTENCY_TTL_MINUTES=5
WAITLIST_CONFIRM_HOURS=24
DROP_DEADLINE_DAYS=7
EOF

chmod 600 "$APP_DIR/.env"
ok "已写入 $APP_DIR/.env（权限 600，已生成随机 AUTH_SECRET）"

# ---------------------------------------------------------------- 7. 依赖与数据

log "7/8 安装依赖并初始化数据库"

cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
ok "依赖安装完成"

if [ "$SKIP_DB_INIT" -eq 1 ]; then
  warn "按要求跳过 db:init（保留现有数据）"
else
  if [ -f "$APP_DIR/.db-initialized" ]; then
    warn "检测到 .db-initialized，为避免清空数据已跳过初始化。"
    warn "确实要重置：删除 $APP_DIR/.db-initialized 后重跑本脚本。"
  else
    npm run db:init
    touch "$APP_DIR/.db-initialized"
    ok "数据库表结构与演示数据已导入"
  fi
fi

# ---------------------------------------------------------------- 8. 常驻与反代

log "8/8 配置后台常驻"

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 --no-audit --no-fund >/dev/null
fi

pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
pm2 start server/app.js --name "$PM2_NAME" --cwd "$APP_DIR" >/dev/null
pm2 save >/dev/null
ok "pm2 已启动应用：$PM2_NAME"

if systemctl list-unit-files 2>/dev/null | grep -q '^pm2-root'; then
  systemctl enable pm2-root >/dev/null 2>&1 || true
  ok "pm2 开机自启已启用"
else
  if pm2 startup systemd -u root --hp /root >/dev/null 2>&1; then
    systemctl enable pm2-root >/dev/null 2>&1 || true
    pm2 save >/dev/null
    ok "pm2 开机自启已启用"
  else
    warn "开机自启未配置成功（不影响现在使用，重启服务器后需手动启动）。"
    warn "可手动执行：pm2 startup systemd -u root --hp /root && pm2 save"
  fi
fi

if [ "$WITH_NGINX" -eq 1 ]; then
  log "附加：安装并配置 Nginx（80 端口反向代理）"
  apt-get install -y -qq nginx
  cat > /etc/nginx/sites-available/course-selection <<EOF
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/course-selection /etc/nginx/sites-enabled/course-selection
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null 2>&1 || die "Nginx 配置校验失败，请检查 /etc/nginx/sites-available/course-selection"
  systemctl reload nginx
  ok "Nginx 已配置，直接访问 80 端口即可"
fi

# ---------------------------------------------------------------- 完成

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="<你的公网IP>"

printf '\n\033[1;32m================ 部署完成 ================\033[0m\n\n'
echo "  访问地址："
if [ "$WITH_NGINX" -eq 1 ]; then
  echo "    http://${PUBLIC_IP}"
fi
echo "    http://${PUBLIC_IP}:${APP_PORT}"
echo
echo "  演示账号（口令见项目 README.md 的「演示账号」一节）："
echo "    学生 2024001 / 教师 teacher001 / 教务 academic / 系统管理 sysadmin"
echo
if [ "${GENERATED_PW:-0}" = "1" ]; then
  echo -e "  \033[1;33m数据库口令（脚本生成，请立即保存）：${DB_PASSWORD}\033[0m"
  echo "    已同时写入 ${APP_DIR}/.env，该文件不会被提交到 git"
  echo
fi

warn "如果浏览器打不开，先回来检查这两处："
echo "      1. 云控制台「安全组/防火墙」是否放行了 22、80、${APP_PORT}"
echo "      2. pm2 status 看进程是否 online；pm2 logs ${PM2_NAME} 看报错"
