@echo off
setlocal EnableExtensions

cd /d "%~dp0" || (
  echo [FAILED] Could not open the repository directory.
  exit /b 1
)

set "NO_OPEN="
if /I "%~1"=="--no-open" set "NO_OPEN=1"

echo.
echo ============================================================
echo  Foldory verified release build
echo ============================================================
echo  Repository: %CD%
echo.

set "FAILED_STEP=npm ci"
echo [1/8] Installing locked dependencies...
call npm ci
if errorlevel 1 goto :failed

set "FAILED_STEP=npm test"
echo.
echo [2/8] Running frontend tests...
call npm test
if errorlevel 1 goto :failed

set "FAILED_STEP=npm run test:e2e"
echo.
echo [3/8] Running end-to-end tests...
call npm run test:e2e
if errorlevel 1 goto :failed

set "FAILED_STEP=cargo test"
echo.
echo [4/8] Running Rust tests...
cargo test --manifest-path src-tauri/Cargo.toml
if errorlevel 1 goto :failed

set "FAILED_STEP=npm run format:check"
echo.
echo [5/8] Checking source formatting...
call npm run format:check
if errorlevel 1 goto :failed

set "FOLDORY_SKIP_OPEN_BUILD=1"
set "FAILED_STEP=npm run tauri build"
echo.
echo [6/8] Building the protected release...
call npm run tauri build
if errorlevel 1 goto :failed

set "FAILED_STEP=npm run privacy:check"
echo.
echo [7/8] Rechecking release privacy...
call npm run privacy:check
if errorlevel 1 goto :failed

set "FAILED_STEP=collecting release artifacts"
echo.
echo [8/8] Collecting verified release files...
for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set "APP_VERSION=%%V"
if not defined APP_VERSION goto :failed

set "RELEASE_ROOT=%CD%\src-tauri\target\release"
set "EXE_SOURCE=%RELEASE_ROOT%\foldory.exe"
set "INSTALLER_SOURCE=%RELEASE_ROOT%\bundle\nsis\Foldory_%APP_VERSION%_x64-setup.exe"
set "OUTPUT_DIR=%CD%\releases\%APP_VERSION%-clean"
set "EXE_OUTPUT=%OUTPUT_DIR%\Foldory_%APP_VERSION%_x64.exe"
set "INSTALLER_OUTPUT=%OUTPUT_DIR%\Foldory_%APP_VERSION%_x64-setup.exe"

if not exist "%EXE_SOURCE%" (
  echo [FAILED] Release executable was not found:
  echo          %EXE_SOURCE%
  goto :failed
)
if not exist "%INSTALLER_SOURCE%" (
  echo [FAILED] Release installer was not found:
  echo          %INSTALLER_SOURCE%
  goto :failed
)

if not exist "%OUTPUT_DIR%\" mkdir "%OUTPUT_DIR%"
if errorlevel 1 goto :failed
copy /y "%EXE_SOURCE%" "%EXE_OUTPUT%" >nul
if errorlevel 1 goto :failed
copy /y "%INSTALLER_SOURCE%" "%INSTALLER_OUTPUT%" >nul
if errorlevel 1 goto :failed

echo.
echo SHA-256 checksums:
echo.
echo %EXE_OUTPUT%
certutil.exe -hashfile "%EXE_OUTPUT%" SHA256
if errorlevel 1 goto :failed
echo.
echo %INSTALLER_OUTPUT%
certutil.exe -hashfile "%INSTALLER_OUTPUT%" SHA256
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo  CLEAN RELEASE BUILD COMPLETED
echo ============================================================
echo  Standalone executable:
echo  %EXE_OUTPUT%
echo.
echo  Windows installer:
echo  %INSTALLER_OUTPUT%
echo.
echo  Output folder:
echo  %OUTPUT_DIR%
echo ============================================================

if not defined NO_OPEN start "" explorer.exe "%OUTPUT_DIR%"
if not defined NO_OPEN pause
exit /b 0

:failed
echo.
echo ============================================================
echo  BUILD FAILED
echo ============================================================
echo  Failed step: %FAILED_STEP%
echo  No release should be published from this run.
echo ============================================================
if not defined NO_OPEN pause
exit /b 1
