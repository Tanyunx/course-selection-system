@echo off
chcp 65001 >nul
title 在线选课系统 - 后端服务（关闭本窗口即停止）
cd /d "%~dp0"

set JAR=backend\target\course-selection-backend.jar
set ENVFILE=backend\.env

echo.
echo   ==================================================
echo      在线选课系统（Spring Boot 3 + PostgreSQL）
echo   ==================================================
echo.
echo      后端地址：http://127.0.0.1:3000
echo      健康检查：http://127.0.0.1:3000/api/health
echo.
echo      前端是纯静态资源，需另开一个静态服务器托管：
echo          cd frontend ^&^& python -m http.server 5500
echo      然后浏览器访问 http://127.0.0.1:5500
echo.
echo      关闭本窗口即停止后端服务。
echo.
echo   --------------------------------------------------
echo.

if not exist "%ENVFILE%" (
  echo   [首次运行] 未找到 %ENVFILE%
  echo.
  echo   请先复制模板并填写数据库连接信息（重点是 DB_PASSWORD）：
  echo       copy backend\.env.example backend\.env
  echo   同时确认 PostgreSQL 已启动，且已用 tools\pg-setup.sh 建好库。
  echo.
  if exist "backend\.env.example" (
    copy /y "backend\.env.example" "backend\.env" >nul
    echo   已为你生成 %ENVFILE%，现在打开记事本，请填写 DB_PASSWORD 后保存并重新运行本文件。
    echo.
    notepad "%ENVFILE%"
  )
  pause
  exit /b 1
)

if not exist "%JAR%" (
  echo   [首次运行] 未找到已构建的 jar，开始用 Maven 打包（可能需要几分钟）...
  echo.
  pushd backend
  call mvn -DskipTests clean package
  if errorlevel 1 (
    popd
    echo.
    echo   打包失败。请确认已安装 JDK 17+ 与 Maven，并在 backend 目录手工执行：
    echo       mvn -DskipTests package
    pause
    exit /b 1
  )
  popd
  echo.
  echo   打包完成。
  echo.
)

rem 加载 backend\.env 到当前进程环境（Spring Boot 会自动读取这些变量）
rem eol=# 让以 # 开头的注释行被跳过，因此不需要延迟展开
echo   正在加载 %ENVFILE% ...
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENVFILE%") do (
  if not "%%A"=="" set "%%A=%%B"
)

echo.
echo   启动中，请稍候（首次启动会导入演示数据，约 5~10 秒）...
echo.

rem 显式用命令行参数下发监听地址与端口：
rem 命令行优先级高于环境变量与配置文件，可以压过 IDE / 云平台预设的 SERVER__PORT 之类变量
set APP_PORT=3000
if defined SERVER_PORT set APP_PORT=%SERVER_PORT%
set APP_ADDR=127.0.0.1
if defined SERVER_ADDRESS set APP_ADDR=%SERVER_ADDRESS%

rem 首次运行（数据库还是空的）时加 --app.db.init-on-startup=true 可自动建表导数据，
rem 但每次启动都会清空重建，所以默认不开启：
rem   java -jar "%JAR%" --app.db.init-on-startup=true
java -jar "%JAR%" --server.address=%APP_ADDR% --server.port=%APP_PORT%

echo.
echo   服务已停止。
pause
