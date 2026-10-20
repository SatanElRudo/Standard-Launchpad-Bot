@echo off
chcp 65001 >nul
title Standard Launchpad Bot Console
echo ========================================================
echo   Standard Launchpad Bot - Startskript
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [FEHLER] Node.js ist nicht installiert oder nicht im PATH gefunden!
  echo Bitte installiere Node.js v20+ von https://nodejs.org/
  pause
  exit /b 1
)

if not exist "dist" (
  echo Baue Web-Frontend...
  call npm run build
)

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:4317"

echo Starte Server auf http://127.0.0.1:4317 ...
echo Drücke Strg+C zum Beenden oder führe stop-bot.bat aus.
echo.
node server/index.mjs
pause
