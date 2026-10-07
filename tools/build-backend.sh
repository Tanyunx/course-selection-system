#!/usr/bin/env bash
# ---------------------------------------------------------------
# 打包后端（Java / Spring Boot → 可执行 jar）
#
# 做的事：
#   1. 定位 java / mvn（优先 JAVA_HOME 与 PATH，回退到开发机上的固定路径）
#   2. 用国内镜像（tools/maven-settings.xml，走阿里云 public 仓）执行 package
#   3. 产出 backend/target/course-selection-backend.jar
#
# 用法：
#   bash tools/build-backend.sh            正常打包（跳过测试）
#   bash tools/build-backend.sh --with-tests   打包并跑单元测试
# ---------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"

SKIP_TESTS="-DskipTests"
if [ "${1:-}" = "--with-tests" ]; then
  SKIP_TESTS=""
  echo "本次打包会执行单元测试"
fi

# ---- 定位 java ----
if [ -n "${JAVA_HOME:-}" ] && { [ -x "$JAVA_HOME/bin/java" ] || [ -x "$JAVA_HOME/bin/java.exe" ]; }; then
  export JAVA_HOME
elif [ -x "C:/Program Files/Java/jdk-21" ]; then
  export JAVA_HOME="C:/Program Files/Java/jdk-21"
fi

# ---- 定位 mvn ----
if command -v mvn >/dev/null 2>&1; then
  MVN="mvn"
elif [ -x "$HOME/.workbuddy/binaries/maven/apache-maven-3.9.16/bin/mvn" ]; then
  MVN="$HOME/.workbuddy/binaries/maven/apache-maven-3.9.16/bin/mvn"
elif [ -x "/c/Users/TAN30/.workbuddy/binaries/maven/apache-maven-3.9.16/bin/mvn" ]; then
  MVN="/c/Users/TAN30/.workbuddy/binaries/maven/apache-maven-3.9.16/bin/mvn"
elif [ -x "$ROOT/backend/mvnw" ]; then
  MVN="$ROOT/backend/mvnw"          # Maven Wrapper：无需预装 Maven
else
  echo "找不到 mvn。请安装 Maven 3.9+ 后重试，或在服务器上用 deploy.sh 自动安装。" >&2
  exit 1
fi

# 存在 wrapper 时优先用 wrapper，保证各处构建行为一致
[ -x "$ROOT/backend/mvnw" ] && MVN="$ROOT/backend/mvnw"

echo "使用 Maven：$MVN"
echo "Maven 镜像：tools/maven-settings.xml（阿里云 public）"
echo

"$MVN" -s "$ROOT/tools/maven-settings.xml" -q $SKIP_TESTS clean package

JAR="$ROOT/backend/target/course-selection-backend.jar"
if [ -f "$JAR" ]; then
  echo
  echo "打包完成：$JAR（$(du -h "$JAR" | cut -f1)）"
  echo "启动：bash tools/run-backend.sh"
else
  echo "打包结束但未找到 jar，请检查上面的构建输出。" >&2
  exit 1
fi
