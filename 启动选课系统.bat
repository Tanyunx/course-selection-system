@echo off
title Course Selection System - Server (close this window to stop)
cd /d "%~dp0"

echo.
echo   ==================================================
echo      Course Selection System  is starting ...
echo   ==================================================
echo.
echo      After it is ready, open this address in a browser:
echo.
echo          http://127.0.0.1:3000
echo.
echo      Closing this window stops the service.
echo      If the page looks stale, press Ctrl + F5 to reload.
echo.
echo   --------------------------------------------------
echo.

if not exist node_modules (
  echo   [First run] Installing dependencies, please wait ...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Failed to install dependencies.
    echo   Please check that Node.js is installed and the network works.
    pause
    exit /b 1
  )
)

if not exist .env (
  echo   [Setup] No .env file found - creating one from .env.example ...
  copy /y ".env.example" ".env" >nul
  echo.
  echo   Please edit .env and set DB_PASSWORD to your MySQL password,
  echo   then run this file again.
  echo.
  notepad ".env"
  pause
  exit /b 1
)

call npm start

echo.
echo   Service stopped.
pause
