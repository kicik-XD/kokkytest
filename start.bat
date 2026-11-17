@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8000"
set "PY="

where python >nul 2>nul
if not errorlevel 1 set "PY=python"

if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py"
)

if not defined PY (
  echo.
  echo Python не найден. Установите Python или запустите любой локальный сервер в этой папке.
  echo.
  pause
  exit /b 1
)

echo.
echo   kokky запускается на http://localhost:%PORT%/
echo   Не закрывайте это окно, пока пользуетесь плеером.
echo   Остановить сервер: Ctrl+C.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%/'"
%PY% -m http.server %PORT%

pause
