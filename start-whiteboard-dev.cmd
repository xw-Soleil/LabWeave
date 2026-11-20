@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0.local\toolchain\node-v26.13.0-win-x64\node.exe" set "PATH=%~dp0.local\toolchain\node-v26.13.0-win-x64;%PATH%"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
if not exist "%~dp0.local\tmp" mkdir "%~dp0.local\tmp"
set "TEMP=%~dp0.local\tmp"
set "TMP=%TEMP%"
set "npm_config_cache=%~dp0.local\npm-cache"
set "CARGO_TARGET_DIR=%~dp0.local\cargo-target"
if not exist "node_modules\.bin\vitest.cmd" (
  call npm exec --yes --package=pnpm@11.3.0 -- pnpm install --frozen-lockfile
  if errorlevel 1 goto failed
)
call npm exec --yes --package=pnpm@11.3.0 -- pnpm --config.verify-deps-before-run=ignore --filter @graphif/project-graph tauri dev --config src-tauri/tauri.research-dev.conf.json
if errorlevel 1 goto failed
exit /b 0
:failed
echo LabWeave Preview could not start. See the error above.
pause
exit /b 1
