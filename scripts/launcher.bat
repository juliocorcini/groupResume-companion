@echo off
title GroupResume Companion
cd /d "%~dp0.."
echo.
echo ╔══════════════════════════════════════════╗
echo ║   Starting GroupResume Companion...      ║
echo ╚══════════════════════════════════════════╝
echo.
node dist/server.js
pause
