@echo off
setlocal

set "BUILD_DIR=%~dp0src-tauri\target\release\bundle\nsis"

if not exist "%BUILD_DIR%\" (
  echo Build output directory was not found: "%BUILD_DIR%"
  exit /b 1
)

start "" explorer.exe "%BUILD_DIR%"
endlocal
