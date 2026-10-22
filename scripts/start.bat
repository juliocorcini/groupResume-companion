@echo off
title GroupResume Companion
cd /d "%~dp0\.."

echo.
echo   ========================================
echo      GroupResume Companion
echo   ========================================
echo.

:: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo   [ERROR] Node.js not found!
    echo   Install with: winget install OpenJS.NodeJS.LTS
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules\" (
    echo   Installing dependencies (first time only)...
    call npm install
    echo.
)

:: Build TypeScript if needed
if not exist "dist\" (
    echo   Building TypeScript...
    call npx tsc
    echo.
)

:: Open browser
start http://localhost:3000

:: Start server
echo   Starting server...
echo   Close this window to stop.
echo.
node dist/server.js
