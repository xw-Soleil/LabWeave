@echo off
setlocal
cd /d "%~dp0"

rem Prefer the isolated runtime installed for this checkout; leave system Node unchanged.
if exist "%~dp0.local\toolchain\node-v26.13.0-win-x64\node.exe" set "PATH=%~dp0.local\toolchain\node-v26.13.0-win-x64;%PATH%"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
if not defined CARGO_TARGET_DIR set "CARGO_TARGET_DIR=%~dp0.local\cargo-target"
if not exist "%~dp0.local\tmp" mkdir "%~dp0.local\tmp"
attrib +h "%~dp0.local" >nul 2>nul
set "TEMP=%~dp0.local\tmp"
set "TMP=%TEMP%"
set "npm_config_cache=%~dp0.local\npm-cache"

where node >nul 2>nul
if errorlevel 1 goto prerequisites
node --eval "process.exit(Number(process.versions.node.split('.')[0]) >= 26 ? 0 : 1)"
if errorlevel 1 goto prerequisites
where cargo >nul 2>nul
if errorlevel 1 goto prerequisites

if not exist "node_modules\.bin\vitest.cmd" (
  call npm exec --yes --package=pnpm@11.3.0 -- pnpm install --frozen-lockfile
  if errorlevel 1 goto failed
)
echo Starting LabWeave whiteboard. Close this console with Ctrl+C after closing the app.
call npm exec --yes --package=pnpm@11.3.0 -- pnpm dev
if errorlevel 1 goto failed
exit /b 0

:prerequisites
echo Node.js 26+, Rust stable, Visual Studio C++ Build Tools and WebView2 are required.
echo See README.md for setup instructions.
:failed
echo Whiteboard could not start. See the error above.
pause
exit /b 1
