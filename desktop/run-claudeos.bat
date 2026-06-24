@echo off
REM ===== ClaudeOS desktop launcher (Windows) =====
REM Double-click this file (or run it from cmd) to open ClaudeOS in its own window.
REM First run installs Electron (~150 MB, one time); after that it just launches.

cd /d "%~dp0"

REM Where ClaudeOS is served from (the server). Override here if your host/port differ.
if "%CLAUDEOS_URL%"=="" set CLAUDEOS_URL=http://localhost:4317

where npm >nul 2>nul
if errorlevel 1 (
  echo [ClaudeOS] Node.js / npm not found. Install Node LTS from https://nodejs.org then re-run.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [ClaudeOS] First-time setup: installing Electron ^(~150 MB, one time^)...
  call npm install
  if errorlevel 1 (
    echo [ClaudeOS] npm install failed.
    pause
    exit /b 1
  )
)

echo [ClaudeOS] Launching  %CLAUDEOS_URL%
call npm start
