@echo off
chcp 65001 >nul
echo ========================================================
echo   Standard Launchpad Bot - Stoppen
echo ========================================================
echo.
echo Stoppe Server auf Port 4317...

powershell -Command "Get-NetTCPConnection -LocalPort 4317 -ErrorAction SilentlyContinue | ForEach-Object { if ($_.OwningProcess -gt 0) { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"

echo.
echo Bot wurde erfolgreich beendet.
timeout /t 3 >nul
