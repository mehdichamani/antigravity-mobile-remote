@echo off
setlocal
title Antigravity Mobile Remote Installer

echo =======================================================
echo    🚀 Antigravity Mobile Remote - Windows Setup
echo =======================================================

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please download and install Node.js (v18+) from https://nodejs.org
    pause
    exit /b 1
)

cd /d "%~dp0"
node scripts\installer.js

pause
