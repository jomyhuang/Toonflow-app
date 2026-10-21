@echo off
rem Run toonflow natively (no Docker). Data dir = repo-root data\ (shared with container mode).
cd /d "%~dp0"
set TOONFLOW_PORT=3210
set NODE_ENV=production
if not exist "build\server\index.js" (
  echo [ERROR] build\server\index.js missing. Run: bun install ^&^& bun run build
  exit /b 1
)
bun build/server/index.js
