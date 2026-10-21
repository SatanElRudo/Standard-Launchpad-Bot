@echo off
title Standard Launchpad Bot - Beenden
echo ========================================================
echo   Standard Launchpad Bot - Stoppen
echo ========================================================
echo.
echo Stoppe Server auf Port 4317...

powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4317 -ErrorAction SilentlyContinue | ForEach-Object { if ($_.OwningProcess -gt 0) { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"

echo.
echo Bot wurde erfolgreich beendet.
ping -n 3 127.0.0.1 >nul
