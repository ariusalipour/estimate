@echo off
setlocal

echo [1/4] Checking frontend dependencies...
if not exist "frontend\node_modules" (
  call npm --prefix frontend install
  if errorlevel 1 exit /b %errorlevel%
)

echo [2/4] Checking worker dependencies...
if not exist "worker\node_modules" (
  call npm --prefix worker install
  if errorlevel 1 exit /b %errorlevel%
)

echo [3/4] Building Astro frontend...
call npm --prefix frontend run build
if errorlevel 1 exit /b %errorlevel%

echo [4/4] Starting Cloudflare worker...
call npm --prefix worker run dev
