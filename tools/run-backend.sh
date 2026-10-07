#!/usr/bin/env bash
# ---------------------------------------------------------------
# 本地启动后端（Java / Spring Boot）
#
# 做的事：
#   1. 读取 backend/.env（存在才读）并导出为环境变量
#   2. 用 JDK 21 跑打包好的 jar
#   3. 传参给 Spring Boot：
#        --app.db.init-on-startup=true  重建演示库（可选）
#
# 用法：
#   bash tools/run-backend.sh            正常启动
#   bash tools/run-backend.sh --init     重建演示库后启动
# ---------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAR="$ROOT/backend/target/course-selection-backend.jar"
ENVFILE="$ROOT/backend/.env"

# 定位 java：优先 JAVA_HOME（Linux 服务器上通常已设），
# 其次 PATH 中的 java，最后回退到 Windows 常见安装路径。
# 这样同一份脚本在 Windows 开发机与 Ubuntu 学生机上都能直接跑。
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA="$JAVA_HOME/bin/java"
elif [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java.exe" ]; then
  JAVA="$JAVA_HOME/bin/java.exe"
elif command -v java >/dev/null 2>&1; then
  JAVA="java"
elif [ -x "C:/Program Files/Java/jdk-21/bin/java.exe" ]; then
  JAVA="C:/Program Files/Java/jdk-21/bin/java.exe"
else
  echo "找不到 java。请安装 JDK 21，或设置 JAVA_HOME 后重试。" >&2
  exit 1
fi

if [ ! -f "$JAR" ]; then
  echo "未找到 $JAR，请先在 backend/ 目录执行："
  echo "  mvn -s ../tools/maven-settings.xml -DskipTests package"
  exit 1
fi

# 加载 .env（只导出键值对，跳过注释与空行）
if [ -f "$ENVFILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    export "$key=$val"
  done < "$ENVFILE"
  echo "已加载 backend/.env"
else
  echo "提示：backend/.env 不存在，将使用 application.yml 中的默认值"
fi

INIT_ARG=""
if [ "${1:-}" = "--init" ]; then
  INIT_ARG="--app.db.init-on-startup=true"
  echo "注意：本次启动会重建 18 张表并重新导入演示数据"
fi

# 监听地址/端口一律用「命令行参数」下发：
#   命令行参数优先级高于环境变量与配置文件，能压过 IDE / 云平台 / 容器运行时
#   预设的 SERVER__PORT 之类变量（Spring 宽松绑定会把 SERVER__PORT 解析成 server.port）。
APP_PORT="${SERVER_PORT:-3000}"
APP_ADDR="${SERVER_ADDRESS:-127.0.0.1}"

echo "监听 http://${APP_ADDR}:${APP_PORT}"
exec "$JAVA" -jar "$JAR" \
  --server.port="$APP_PORT" \
  --server.address="$APP_ADDR" \
  $INIT_ARG
