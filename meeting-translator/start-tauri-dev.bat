@echo off
setlocal

cd /d "%~dp0"
title meeting-translator tauri dev

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. Please install Node.js and ensure npm is in PATH.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [INFO] node_modules not found. Running npm install...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [INFO] Starting Tauri dev on http://localhost:1430 ...
call npm run tauri dev
set EXIT_CODE=%ERRORLEVEL%

if not %EXIT_CODE%==0 (
    echo [ERROR] Tauri dev exited with code %EXIT_CODE%.
    pause
    exit /b %EXIT_CODE%
)

echo [INFO] Tauri dev stopped.
pause
endlocal
