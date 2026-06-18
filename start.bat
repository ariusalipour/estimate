@echo off
cd /d "%~dp0"
echo Building frontend...
cd frontend
call npm run build
echo Starting dev server...
cd ..\worker
npx wrangler dev