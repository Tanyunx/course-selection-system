#!/usr/bin/env bash
#
# 选课系统 · 云服务器一键部署脚本（Java Web + PostgreSQL 版）
# 适用：Ubuntu 20.04 / 22.04 / 24.04 / 26.04（Debian 系同理）
#
# 用法（在服务器上、项目根目录内执行）：
#   sudo bash deploy.sh                          # 完整部署：JDK + PostgreSQL + Nginx + 后端 jar
#   sudo bash deploy.sh --skip-db-init           # 不重建数据库（保留现有数据）
#   sudo bash deploy.sh --domain kc.example.com --email me@example.com
#                                                # 顺带用 certbot 申请 HTTPS 证书并自动跳转
#   sudo bash deploy.sh --port 3000 --dir /opt/course-selection
#
# 部署完成后：
#   前端  由 Nginx 托管 frontend/ 静态资源
#   后端  systemd 常驻，只监听 127.0.0.1:3000
#   入口  Nginx 的 / 指向前端，/api 反向代理到后端 —— 浏览器只看到同源，天然没有跨域问题
#
# 说明：脚本可重复执行，已装好的部分会自动跳过；数据库默认只在首次初始化。
#

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_NAME="${DB_NAME:-course_selection}"
DB_USER="${DB_USER:-course_app}"
APP_PORT="${SERVER_PORT:-3000}"
APP_ADDR="127.0.0.1"
SERVICE_NAME="course-selection"
NGINX_SITE="/etc/nginx/sites-available/${SERVICE_NAME}"
DOMAIN=""
EMAIL=""
SKIP_DB_INIT=0
# 允许用户指定最低 JDK 版本（>=17 都能编译本项目）
MIN_JAVA=17

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
info() { printf '    · %s\n' "$*"; }
warn() { printf '\n\033[1;33m[注意]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

ARGC=$#
# 取值型参数统一在这里校验，避免 --port 后面漏写值时被 set -u 打断、还看不出原因。
# 注意：函数内的 $# 是函数自己的参数个数，所以要用外层存下来的 ARGC。
need_value() {
  [ "$1" -le "$ARGC" ] && [ -n "${!1:-}" ] || die "参数 ${2} 缺少取值"
}

for ((i = 1; i <= ARGC; i++)); do
  arg="${!i}"
  case "$arg" in
    --skip-db-init) SKIP_DB_INIT=1 ;;
    --port)   i=$((i + 1)); need_value "$i" "--port";   APP_PORT="${!i}" ;;
    --dir)    i=$((i + 1)); need_value "$i" "--dir";    APP_DIR="${!i}" ;;
    --domain) i=$((i + 1)); need_value "$i" "--domain"; DOMAIN="${!i}" ;;
    --email)  i=$((i + 1)); need_value "$i" "--email";  EMAIL="${!i}" ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "未知参数：$arg（可用 --skip-db-init / --port / --dir / --domain / --email）" ;;
  esac
done

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# ---------------------------------------------------------------- 0. 前置检查

log "0/9 前置检查"

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy.sh"

command -v apt-get >/dev/null 2>&1 || die "本脚本只支持 Debian/Ubuntu 系（apt-get 不存在）"

[ -f "$APP_DIR/backend/pom.xml" ] || die "没找到 $APP_DIR/backend/pom.xml，请把脚本放在项目根目录执行（当前：$APP_DIR）"
[ -f "$APP_DIR/backend/src/main/resources/db/schema-pg.sql" ] || die "没找到 PostgreSQL 建表脚本，项目文件不完整"
[ -f "$APP_DIR/frontend/index.html" ] || die "没找到 frontend/index.html，项目文件不完整"

ok "root 权限、Debian 系、项目文件齐全（$APP_DIR）"

# ---------------------------------------------------------------- 1. 软件源

log "1/9 更新软件源"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
ok "软件源已更新"

# ---------------------------------------------------------------- 2. JDK

log "2/9 安装 JDK（需要 ${MIN_JAVA}+，本项目按 Java Web / Spring Boot 3 编写）"

install_jdk() {
  # 按优先级尝试；TencentOS / Ubuntu 官方源通常已包含 openjdk-21
  for pkg in openjdk-21-jdk-headless openjdk-21-jdk openjdk-17-jdk-headless default-jdk-headless; do
    if apt-get install -y -qq "$pkg" >/dev/null 2>&1; then
      echo "$pkg"
      return 0
    fi
  done
  return 1
}

JAVA_BIN="$(command -v java || true)"
JDK_MAJOR=0
if [ -n "$JAVA_BIN" ]; then
  JDK_MAJOR="$(java -XshowSettings:properties -version 2>&1 | awk -F'= *' '/java.specification.version/{print $2}' | tr -d ' ' | cut -d. -f1)"
  JDK_MAJOR="${JDK_MAJOR:-0}"
fi

if [ "$JDK_MAJOR" -ge "$MIN_JAVA" ] 2>/dev/null; then
  ok "已安装 JDK ${JDK_MAJOR}（$(java -version 2>&1 | head -1)），跳过"
else
  PKG="$(install_jdk)" || die "JDK 安装失败。请手动安装 JDK 17+（例如 apt install openjdk-21-jdk-headless）后重跑本脚本。"
  JDK_MAJOR="$(java -XshowSettings:properties -version 2>&1 | awk -F'= *' '/java.specification.version/{print $2}' | tr -d ' ' | cut -d. -f1)"
  ok "已安装 ${PKG}，java -version → $(java -version 2>&1 | head -1)"
fi

[ "$JDK_MAJOR" -ge "$MIN_JAVA" ] 2>/dev/null || die "检测到的 Java 版本为 $JDK_MAJOR，低于要求的 $MIN_JAVA"

# ---------------------------------------------------------------- 3. Maven

log "3/9 安装 Maven 并配置国内镜像"

if ! command -v mvn >/dev/null 2>&1; then
  apt-get install -y -qq maven || die "Maven 安装失败"
fi
ok "Maven $(mvn -v 2>/dev/null | awk 'NR==1{print $3}')"

# 阿里云 public 仓库：服务器在国内时能把依赖下载时间从十几分钟压到一两分钟
if [ ! -f /root/.m2/settings.xml ]; then
  mkdir -p /root/.m2
  cat > /root/.m2/settings.xml <<'XML'
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <mirrors>
    <mirror>
      <id>aliyun-public</id>
      <name>Aliyun Public</name>
      <url>https://maven.aliyun.com/repository/public</url>
      <mirrorOf>central</mirrorOf>
    </mirror>
  </mirrors>
</settings>
XML
  ok "已写入 /root/.m2/settings.xml（Aliyun public 镜像）"
else
  info "已存在 /root/.m2/settings.xml，保留不动"
fi

# ---------------------------------------------------------------- 4. PostgreSQL

log "4/9 安装并启动 PostgreSQL"

if ! command -v psql >/dev/null 2>&1; then
  apt-get install -y -qq postgresql postgresql-contrib || die "PostgreSQL 安装失败"
fi
systemctl enable --now postgresql
ok "PostgreSQL 已启动（$(psql --version)）"

# ---------------------------------------------------------------- 5. 口令

log "5/9 准备数据库口令"

ENV_FILE="$APP_DIR/backend/.env"
REUSE_PW=0

if [ -n "${DB_PASSWORD:-}" ]; then
  ok "从环境变量 DB_PASSWORD 读取到口令"
elif [ -f "$ENV_FILE" ] && grep -q '^DB_PASSWORD=.\+' "$ENV_FILE"; then
  DB_PASSWORD="$(grep '^DB_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  REUSE_PW=1
  ok "复用 backend/.env 中已有的口令"
else
  echo "    要新建/更新数据库账号 ${DB_USER}，请为它设置一个口令。"
  echo "    （直接回车则由脚本生成一个随机强口令，稍后会写入 backend/.env，权限 600）"
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

# ---------------------------------------------------------------- 6. 建库建号

log "6/9 创建数据库与专用账号"

# PostgreSQL 没有 MySQL 的 CREATE USER IF NOT EXISTS，用 DO 块做成幂等的
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "${DB_USER}" -E UTF8 "${DB_NAME}"
  ok "已创建数据库 ${DB_NAME}"
else
  info "数据库 ${DB_NAME} 已存在"
fi

# PostgreSQL 15 起 public schema 的属主是 pg_database_owner，
# 不显式改属主的话，应用账号导入建表脚本会报 permission denied for schema public
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "${DB_NAME}" <<SQL
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
SQL

ok "数据库 ${DB_NAME}、账号 ${DB_USER} 就绪（库与 public schema 属主已交给应用账号）"

# ---------------------------------------------------------------- 7. 写入 .env

log "7/9 写入 backend/.env"

if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  warn "已存在 backend/.env，先备份为 .env.bak.* 再覆盖"
fi

# 复用已有 AUTH_SECRET，避免每次重跑部署都把所有人踢下线
AUTH_SECRET_VAL="${AUTH_SECRET:-}"
if [ -z "$AUTH_SECRET_VAL" ] && [ -f "$ENV_FILE" ] && grep -q '^AUTH_SECRET=.\+' "$ENV_FILE"; then
  AUTH_SECRET_VAL="$(grep '^AUTH_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
fi
[ -n "$AUTH_SECRET_VAL" ] || AUTH_SECRET_VAL="$(gen_secret)"

cat > "$ENV_FILE" <<EOF
# 由 deploy.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 生成（该文件已被 .gitignore 排除，不入版本库）
#
# 变量名刻意避开 PORT / HOST：很多云平台与容器运行时会预设同名变量，
# 会被 Spring 的宽松绑定命中（例如 SERVER__PORT 会变成 server.port），静默改掉监听端口。

# ---------- 服务监听 ----------
# 只监听回环地址：外部一律经 Nginx 反向代理进来，后端端口不对公网暴露
SERVER_ADDRESS=${APP_ADDR}
SERVER_PORT=${APP_PORT}

# ---------- PostgreSQL ----------
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_POOL=10

# ---------- 会话与安全 ----------
AUTH_SECRET=${AUTH_SECRET_VAL}
AUTH_IDLE_MINUTES=30
AUTH_CAPTCHA_AFTER=5

# ---------- 防刷限速 ----------
RL_WINDOW_SECONDS=60
RL_SOFT_LIMIT=10
RL_HARD_LIMIT=20

# ---------- 业务参数 ----------
IDEMPOTENCY_TTL_MINUTES=5
WAITLIST_CONFIRM_HOURS=24
DROP_DEADLINE_DAYS=7

# ---------- 跨域 ----------
# 前端与后端由同一个 Nginx 提供（同源），因此这里收敛为具体域名；
# 若前端单独部署在别的域名/CDN 上，把它加进这个逗号分隔的列表。
CORS_ORIGINS=${CORS_ORIGINS:-*}

# ---------- 数据初始化 ----------
# 首次部署由脚本单独跑一次导入，之后必须保持 false，否则每次重启都会清空数据
DB_INIT=false
EOF

chmod 600 "$ENV_FILE"
ok "已写入 $ENV_FILE（权限 600，已生成随机 AUTH_SECRET）"

# ---------------------------------------------------------------- 8. 构建后端

log "8/9 构建后端（Maven package）"

cd "$APP_DIR/backend"
# java.version 同时控制编译器 release；用实际装到的 JDK 版本覆盖，避免源回退到 17 时装了 21 却编译不过
mvn -q -DskipTests -Djava.version="$JDK_MAJOR" clean package \
  || die "Maven 构建失败。先单独执行 cd $APP_DIR/backend && mvn -DskipTests package 看完整报错。"

JAR="$APP_DIR/backend/target/course-selection-backend.jar"
[ -f "$JAR" ] || die "构建成功但没找到 $JAR"
ok "已产出 $JAR（$(du -h "$JAR" | cut -f1)）"

# ---------------------------------------------------------------- 9. 初始化数据 + 常驻 + Nginx

log "9/9 初始化数据、注册服务、配置 Nginx"

# 9.1 初始化数据库 --------------------------------------------------------
cd "$APP_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

TABLE_EXISTS="$(sudo -u postgres psql -tAc \
  "SELECT to_regclass('public.t_user') IS NOT NULL" -d "$DB_NAME" 2>/dev/null || echo f)"

if [ "$SKIP_DB_INIT" -eq 1 ]; then
  warn "按要求跳过数据初始化"
elif [ "$TABLE_EXISTS" = "t" ]; then
  info "检测到数据表已存在，跳过初始化（要重置：DROP 掉这些表后重跑，或用 --skip-db-init 明确保留）"
else
  info "首次部署：建表并导入演示数据…"
  # web-application-type=none ⇒ 不起 Tomcat，只跑 ApplicationRunner（DbInitializer）
  # timeout 兜底：即使有常驻线程不让进程退出，也不会把部署卡死
  timeout 240 java -jar "$JAR" \
      --spring.main.web-application-type=none \
      --app.db.init-on-startup=true \
      >/tmp/course-selection-init.log 2>&1 || true

  if sudo -u postgres psql -tAc "SELECT count(*) FROM t_user" -d "$DB_NAME" 2>/dev/null | grep -qE '^[1-9]'; then
    ok "建表与演示数据导入完成（详见 /tmp/course-selection-init.log）"
  else
    tail -30 /tmp/course-selection-init.log || true
    die "数据初始化失败，日志见上面 30 行（完整日志：/tmp/course-selection-init.log）"
  fi
fi

# 9.2 systemd -------------------------------------------------------------
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Course Selection System (Spring Boot 3 + PostgreSQL)
Documentation=file://${APP_DIR}/README.md
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}/backend
# 数据库口令、令牌密钥等全部来自这个文件，源码与 unit 里不出现任何口令
EnvironmentFile=${ENV_FILE}
# 命令行参数优先级高于环境变量与配置文件，能压过平台预设的 SERVER__PORT 之类变量
ExecStart=/usr/bin/java -XX:MaxRAMPercentage=70 -jar ${JAR} --server.address=${APP_ADDR} --server.port=${APP_PORT}
SuccessExitStatus=143
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE_NAME}"
ok "systemd 服务 ${SERVICE_NAME} 已启动并设为开机自启"

# 等后端把 Tomcat 拉起来
BACKEND_OK=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://${APP_ADDR}:${APP_PORT}/api/health" >/dev/null 2>&1; then
    BACKEND_OK=1
    break
  fi
  sleep 1
done

if [ "$BACKEND_OK" -eq 1 ]; then
  ok "后端健康检查通过：$(curl -fsS "http://${APP_ADDR}:${APP_PORT}/api/health")"
else
  warn "后端 30 秒内未就绪，下面是你需要的排查命令："
  echo "      systemctl status ${SERVICE_NAME} --no-pager"
  echo "      journalctl -u ${SERVICE_NAME} -n 80 --no-pager"
fi

# 9.3 Nginx：托管前端 + 反代 /api -----------------------------------------
if ! command -v nginx >/dev/null 2>&1; then
  apt-get install -y -qq nginx || die "Nginx 安装失败"
fi

SERVER_NAME="${DOMAIN:-_}"

cat > "$NGINX_SITE" <<EOF
# 前后端分开部署：前端静态资源由 Nginx 直接吐，后端只处理 /api
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    root ${APP_DIR}/frontend;
    index index.html;

    access_log /var/log/nginx/${SERVICE_NAME}.access.log;
    error_log  /var/log/nginx/${SERVICE_NAME}.error.log;

    client_max_body_size 8m;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # 后端 API：反代到 Spring Boot（注意 proxy_pass 末尾不带斜杠，保留 /api 前缀）
    location /api/ {
        proxy_pass http://${APP_ADDR}:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
    }

    # 前端单页应用：找不到的路径回落到 index.html
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # 静态资源长缓存（文件名未做哈希，因此只给中等时长，避免更新后拿不到新版本）
    location ~* \.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?)$ {
        expires 1h;
        add_header Cache-Control "public";
        try_files \$uri =404;
    }
}
EOF

ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/${SERVICE_NAME}"
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "Nginx 配置校验失败，请检查 $NGINX_SITE"
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx
ok "Nginx 已配置：/ → ${APP_DIR}/frontend，/api → ${APP_ADDR}:${APP_PORT}"

# 9.4 防火墙（只放行必要端口） --------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "ufw 已放行 22 / 80 / 443（后端 ${APP_PORT} 保持不对公网开放）"
fi

# 9.5 可选：HTTPS ---------------------------------------------------------
if [ -n "$DOMAIN" ]; then
  log "附加：用 Let's Encrypt 申请 HTTPS 证书（域名 ${DOMAIN}）"
  apt-get install -y -qq certbot python3-certbot-nginx || warn "certbot 安装失败，可稍后手工申请证书"
  if [ -n "$EMAIL" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
      && ok "HTTPS 已启用：https://${DOMAIN}" \
      || warn "证书申请失败。常见原因：域名还没解析到本机公网 IP、安全组未放行 80/443。"
  else
    warn "未提供 --email，跳过证书申请。可手动执行："
    echo "      certbot --nginx -d ${DOMAIN} --agree-tos -m 你的邮箱 --redirect"
  fi
elif command -v certbot >/dev/null 2>&1; then
  info "已装 certbot；有域名后执行 certbot --nginx -d 你的域名 --redirect 即可启用 HTTPS"
fi

# ---------------------------------------------------------------- 完成

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] || PUBLIC_IP="<你的公网IP>"

printf '\n\033[1;32m================ 部署完成 ================\033[0m\n\n'
echo "  访问地址："
if [ -n "$DOMAIN" ]; then
  echo "    https://${DOMAIN}"
fi
echo "    http://${PUBLIC_IP}"
echo
echo "  演示账号（口令统一 123456，详见 README.md「演示账号」一节）："
echo "    学生 2024001 / 教师 teacher001 / 教务 academic / 系统管理员 sysadmin"
echo
echo "  常用运维命令："
echo "    systemctl status ${SERVICE_NAME}       # 后端状态"
echo "    journalctl -u ${SERVICE_NAME} -f       # 后端实时日志"
echo "    systemctl restart ${SERVICE_NAME}      # 重启后端"
echo "    nginx -t && systemctl reload nginx     # 改完 Nginx 配置后重载"
echo "    sudo -u postgres psql -d ${DB_NAME}    # 进数据库"
echo

if [ "${GENERATED_PW:-0}" = "1" ]; then
  echo -e "  \033[1;33m数据库口令（脚本生成，请立即保存）：已写入 ${ENV_FILE}（权限 600，不入版本库）\033[0m"
  echo
fi
[ "$REUSE_PW" -eq 1 ] && echo "  已复用原有数据库口令（见 ${ENV_FILE}）" && echo

warn "如果浏览器打不开，先回来检查这两处："
echo "      1. 云控制台「安全组/防火墙」是否放行了 22、80、443"
echo "         —— 这一步最容易漏；服务器内部 ufw 放行了也不代表云安全组放行了"
echo "      2. systemctl status ${SERVICE_NAME} 看后端是否 active；"
echo "         journalctl -u ${SERVICE_NAME} -n 50 看报错"
echo
warn "上生产前请务必确认："
echo "      · backend/.env 里 DB_INIT 保持 false（否则每次重启都会清空数据）"
echo "      · 有域名后尽快启用 HTTPS：certbot --nginx -d 你的域名 --redirect"
echo "      · 演示账号口令是 123456，正式使用时请通过教务/系统管理端逐个改掉"
