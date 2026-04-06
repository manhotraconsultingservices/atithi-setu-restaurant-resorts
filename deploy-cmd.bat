@echo off
setlocal enabledelayedexpansion
title Atithi Setu -- Deployment (CMD / No Ubuntu required)

:: ================================================================
::  ATITHI SETU — PRODUCTION DEPLOYMENT (Windows CMD Only)
::  No WSL2 Ubuntu terminal needed. Requires Docker Desktop.
::
::  Auto-detects the app folder location by reading the running
::  container labels — works regardless of where the app lives
::  (WSL2 or a Windows folder).
:: ================================================================

:: ----------------------------------------------------------------
::  CONFIGURATION — Only the DEV path needs to match your machine
:: ----------------------------------------------------------------
set DEV_PATH=C:\Users\Admin\Documents\Workspace_MCS\dev-erp.athiti-setu\dev-erp
set BACKUP_WIN_PATH=C:\atithi-setu\backups
set LOG_DIR=C:\atithi-setu\deploy-logs
set APP_IMAGE=dev-erp-app
set APP_CONTAINER=node_app
set DB_CONTAINER=postgres_db
set DB_USER=as_db_user
set APP_WIN_PATH=C:\Users\Admin\Documents\Workspace_MCS\dev-erp.athiti-setu\dev-erp
:: ----------------------------------------------------------------

:: Setup folders
if not exist "%LOG_DIR%"         mkdir "%LOG_DIR%"
if not exist "%BACKUP_WIN_PATH%" mkdir "%BACKUP_WIN_PATH%"

:: Timestamps
for /f "tokens=*" %%i in ('powershell -command "Get-Date -Format yyyyMMdd_HHmm"') do set TS=%%i
for /f "tokens=*" %%i in ('powershell -command "Get-Date -Format yyyyMMdd"')      do set TODAY=%%i

set LOG_FILE=%LOG_DIR%\deploy-%TS%.log
set ROLLBACK_TAG=%APP_IMAGE%:pre-patch-%TODAY%

echo Deployment started: %TS% > "%LOG_FILE%"

:: ================================================================
echo.
echo ================================================================
echo   ATITHI SETU  --  Production Deployment  (CMD mode)
echo   %DATE%  %TIME%
echo   Log: %LOG_FILE%
echo ================================================================
echo.

:: ================================================================
::  STEP 1 — PRE-FLIGHT CHECKS
:: ================================================================
echo [STEP 1] Pre-flight checks
echo ----------------------------------------------------------------

:: 1a. Docker Desktop
docker info >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Docker Desktop is not running. Start it and wait for the whale icon, then retry."
    goto :END_FAIL
)
call :OK "Docker Desktop is running"

:: 1b. Containers exist
docker inspect %DB_CONTAINER% >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Database container '%DB_CONTAINER%' not found."
    goto :END_FAIL
)
call :OK "Database container found: %DB_CONTAINER%"

docker inspect %APP_CONTAINER% >nul 2>&1
if %errorlevel% neq 0 (
    call :WARN "App container '%APP_CONTAINER%' not found (OK for first run)"
) else (
    call :OK "App container found: %APP_CONTAINER%"
)

:: 1c. Source files exist on dev machine
if not exist "%DEV_PATH%\server.ts" (
    call :FAIL "Source file not found: %DEV_PATH%\server.ts"
    goto :END_FAIL
)
if not exist "%DEV_PATH%\src\App.tsx" (
    call :FAIL "Source file not found: %DEV_PATH%\src\App.tsx"
    goto :END_FAIL
)
call :OK "Source files found in dev folder"

:: ================================================================
::  STEP 2 — AUTO-DETECT APP FOLDER PATH
::  Read the compose working directory label from the running
::  container — this works regardless of where the app lives.
:: ================================================================
echo.
echo [STEP 2] Detecting app folder location
echo ----------------------------------------------------------------

:: Read compose project working dir from container labels
for /f "delims=" %%i in ('docker inspect %APP_CONTAINER% --format "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}" 2^>nul') do set COMPOSE_DIR_RAW=%%i

call :INFO "Container reports working dir: %COMPOSE_DIR_RAW%"
echo   [  ..  ] Container reports working dir: %COMPOSE_DIR_RAW% >> "%LOG_FILE%"

if "%COMPOSE_DIR_RAW%"=="" (
    call :WARN "Could not read compose label from container."
    call :INFO "Falling back to manual detection..."
    goto :MANUAL_DETECT
)

:: ── Check if it is a Windows path (second character is ':' = drive letter) ──
set __SECOND_CHAR=%COMPOSE_DIR_RAW:~1,1%
if "%__SECOND_CHAR%"==":" (
    :: Already a Windows path — use directly
    set APP_WIN_PATH=%COMPOSE_DIR_RAW%
    call :OK "App folder is a Windows path: %APP_WIN_PATH%"
    goto :PATH_FOUND
)

:: ── Linux path — convert to Windows UNC via WSL2 ──
:: Strip leading slash so we can build  \\wsl$\<distro>\path
set LINUX_PATH=%COMPOSE_DIR_RAW%

:: Try to find which WSL2 distro has this folder
:: (covers Ubuntu, Ubuntu-22.04, Ubuntu-20.04, Debian, etc.)
set WSL_FOUND=0
for %%D in (Ubuntu-22.04 Ubuntu-24.04 Ubuntu-20.04 Ubuntu Debian) do (
    if !WSL_FOUND! equ 0 (
        set TEST_UNC=\\wsl$\%%D%LINUX_PATH:/=\%
        if exist "!TEST_UNC!\docker-compose.yml" (
            set APP_WIN_PATH=!TEST_UNC!
            set WSL_DISTRO_FOUND=%%D
            set WSL_FOUND=1
            call :OK "App folder found in WSL2 distro '%%D': !APP_WIN_PATH!"
        )
    )
)

if %WSL_FOUND% equ 0 (
    call :WARN "Could not map Linux path '%LINUX_PATH%' to a WSL2 distro automatically."
    goto :MANUAL_DETECT
)
goto :PATH_FOUND

:: ── Manual detection fallback ──
:MANUAL_DETECT
call :INFO "Checking common locations..."
set WSL_FOUND=0

:: Try Windows-native paths first (DEV_PATH itself is checked first)
for %%P in ("%DEV_PATH%" "C:\atithi-setu" "C:\opt\atithi-setu" "C:\dev-erp") do (
    if !WSL_FOUND! equ 0 (
        if exist "%%~P\docker-compose.yml" (
            set APP_WIN_PATH=%%~P
            set WSL_FOUND=1
            call :OK "App folder found at: %%~P"
        )
    )
)

:: Try WSL2 distros + common Linux paths
for %%D in (Ubuntu-22.04 Ubuntu-24.04 Ubuntu-20.04 Ubuntu Debian) do (
    for %%L in (\opt\atithi-setu \home\deploy\atithi-setu \root\atithi-setu) do (
        if !WSL_FOUND! equ 0 (
            set TEST_UNC=\\wsl$\%%D%%L
            if exist "!TEST_UNC!\docker-compose.yml" (
                set APP_WIN_PATH=!TEST_UNC!
                set WSL_FOUND=1
                call :OK "App folder found: !APP_WIN_PATH!"
            )
        )
    )
)

if %WSL_FOUND% equ 0 (
    echo.
    call :FAIL "Could not find docker-compose.yml in any known location."
    echo.
    echo   Please find the correct folder by running this in CMD:
    echo     docker inspect %APP_CONTAINER% --format "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}"
    echo.
    echo   Then open deploy-cmd.bat in Notepad and add this line
    echo   near the top of the CONFIGURATION section:
    echo     set APP_WIN_PATH=^<your folder path here^>
    echo.
    goto :END_FAIL
)

:PATH_FOUND
call :INFO "Using app folder: %APP_WIN_PATH%"
echo.

:: ================================================================
::  STEP 3 — CONFIRMATION
:: ================================================================
echo ================================================================
echo   READY TO DEPLOY
echo.
echo   Files to copy:
echo     server.ts    (owner upsert + resend email + profile API)
echo     src\App.tsx  (My Profile UI + email status banner)
echo.
echo   Source : %DEV_PATH%
echo   Target : %APP_WIN_PATH%
echo ================================================================
echo.
set /p CONFIRM="Type YES to start deployment: "
if /i not "%CONFIRM%"=="YES" (
    echo Deployment cancelled.
    goto :END_CANCEL
)
echo.

:: ================================================================
::  STEP 4 — DATABASE BACKUP
:: ================================================================
echo [STEP 4] Taking database backup (via docker exec)
echo ----------------------------------------------------------------

set BACKUP_FILE=%BACKUP_WIN_PATH%\db_backup_%TS%.sql
call :INFO "Running pg_dumpall inside %DB_CONTAINER%..."

docker exec %DB_CONTAINER% pg_dumpall -U %DB_USER% > "%BACKUP_FILE%" 2>> "%LOG_FILE%"
if %errorlevel% neq 0 (
    call :WARN "Backup returned an error. Check: %LOG_FILE%"
    set /p SKIP_BK="Type SKIP to continue anyway, or press Enter to abort: "
    if /i not "!SKIP_BK!"=="SKIP" (
        call :FAIL "Aborted. Fix backup before deploying."
        goto :END_FAIL
    )
    call :WARN "Skipping backup check at user request."
) else (
    for %%F in ("%BACKUP_FILE%") do set BK_SIZE=%%~zF
    if !BK_SIZE! LSS 100 (
        call :WARN "Backup file is very small (!BK_SIZE! bytes) — may be empty."
    ) else (
        call :OK "Backup saved: %BACKUP_FILE% (!BK_SIZE! bytes)"
    )
)
echo.

:: ================================================================
::  STEP 5 — TAG CURRENT IMAGE FOR ROLLBACK
:: ================================================================
echo [STEP 5] Saving current image for rollback
echo ----------------------------------------------------------------

docker tag %APP_IMAGE%:latest %ROLLBACK_TAG% >nul 2>&1
if %errorlevel% neq 0 (
    call :WARN "Could not tag image (may not exist yet — OK for first deploy)"
) else (
    call :OK "Rollback image saved as: %ROLLBACK_TAG%"
)
echo.

:: ================================================================
::  STEP 6 — COPY FILES
::  Skip if DEV_PATH and APP_WIN_PATH are the same folder
::  (dev machine = production machine scenario)
:: ================================================================
echo [STEP 6] Copying changed files to production
echo ----------------------------------------------------------------

:: Normalise both paths for comparison (remove trailing backslash)
set _SRC=%DEV_PATH%
set _DST=%APP_WIN_PATH%
if "%_SRC:~-1%"=="\" set _SRC=%_SRC:~0,-1%
if "%_DST:~-1%"=="\" set _DST=%_DST:~0,-1%

if /i "%_SRC%"=="%_DST%" (
    call :OK "Source and target are the same folder -- copy skipped (files already in place)"
    call :OK "server.ts  -- already current"
    call :OK "src\App.tsx -- already current"
) else (
    call :INFO "Copying server.ts ..."
    copy /Y "%DEV_PATH%\server.ts" "%APP_WIN_PATH%\server.ts" >> "%LOG_FILE%" 2>&1
    if %errorlevel% neq 0 (
        call :FAIL "Failed to copy server.ts"
        goto :OFFER_ROLLBACK
    )
    call :OK "server.ts copied"

    call :INFO "Copying src\App.tsx ..."
    copy /Y "%DEV_PATH%\src\App.tsx" "%APP_WIN_PATH%\src\App.tsx" >> "%LOG_FILE%" 2>&1
    if %errorlevel% neq 0 (
        call :FAIL "Failed to copy src\App.tsx"
        goto :OFFER_ROLLBACK
    )
    call :OK "src\App.tsx copied"
)
echo.

:: ================================================================
::  STEP 7 — VERIFY FILES
:: ================================================================
echo [STEP 7] Verifying copied files
echo ----------------------------------------------------------------

findstr /C:"No owner record found" "%APP_WIN_PATH%\server.ts" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "server.ts verification failed — new code not found. Wrong file?"
    goto :OFFER_ROLLBACK
)
call :OK "server.ts verified (owner upsert code present)"

findstr /C:"ownerProfile" "%APP_WIN_PATH%\src\App.tsx" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "App.tsx verification failed — new code not found. Wrong file?"
    goto :OFFER_ROLLBACK
)
call :OK "App.tsx verified (owner profile code present)"
echo.

:: ================================================================
::  STEP 8 — BUILD DOCKER IMAGE
::  pushd maps the UNC/Windows path to a temp drive letter so
::  docker compose can resolve relative paths in docker-compose.yml
:: ================================================================
echo [STEP 8] Building Docker image  (3-5 minutes -- please wait)
echo ----------------------------------------------------------------

pushd "%APP_WIN_PATH%"
if %errorlevel% neq 0 (
    call :FAIL "Cannot change to app folder: %APP_WIN_PATH%"
    goto :OFFER_ROLLBACK
)

call :INFO "Build started. Output is being logged to %LOG_FILE% ..."
docker compose build --no-cache app >> "%LOG_FILE%" 2>&1
set BUILD_ERR=%errorlevel%
popd

if %BUILD_ERR% neq 0 (
    call :FAIL "Docker build FAILED. Showing last 20 lines of log:"
    echo.
    powershell -command "Get-Content '%LOG_FILE%' | Select-Object -Last 20"
    echo.
    goto :OFFER_ROLLBACK
)
call :OK "Docker image built successfully"
echo.

:: ================================================================
::  STEP 9 — DEPLOY
:: ================================================================
echo [STEP 9] Deploying new container
echo ----------------------------------------------------------------

pushd "%APP_WIN_PATH%"
docker compose up -d app >> "%LOG_FILE%" 2>&1
set UP_ERR=%errorlevel%
popd

if %UP_ERR% neq 0 (
    call :FAIL "docker compose up failed."
    goto :OFFER_ROLLBACK
)

call :INFO "Waiting 15 seconds for app to start..."
timeout /t 15 /nobreak >nul
call :OK "Container started"
echo.

:: ================================================================
::  STEP 10 — VERIFY STARTUP LOGS
:: ================================================================
echo [STEP 10] Checking startup logs
echo ----------------------------------------------------------------

echo.
docker logs %APP_CONTAINER% --tail=20 2>&1
echo.

docker logs %APP_CONTAINER% --tail=30 2>&1 | findstr /C:"Server running on" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "App did not start correctly — 'Server running on' not in logs."
    call :INFO "Full logs: docker logs %APP_CONTAINER% --tail=50"
    goto :OFFER_ROLLBACK
)
call :OK "Application is running (Server running on port 5001)"
echo.

:: ================================================================
::  STEP 11 — HEALTH CHECK
:: ================================================================
echo [STEP 11] Health check
echo ----------------------------------------------------------------

curl --version >nul 2>&1
if %errorlevel% neq 0 (
    call :WARN "curl not found — skipping HTTP check"
) else (
    for /f "tokens=*" %%i in ('curl -s -o nul -w "%%{http_code}" http://localhost:5001/api/public/restaurants 2^>nul') do set HC=%%i
    if "!HC!"=="200" (
        call :OK "API health check passed -- HTTP 200"
    ) else (
        call :WARN "API returned HTTP !HC! (expected 200). Check manually."
    )
)

echo.
call :INFO "Container status:"
docker ps --filter "name=%APP_CONTAINER%" --filter "name=%DB_CONTAINER%" --format "  {{.Names}}  |  {{.Status}}  |  {{.Ports}}"
echo.

:: ================================================================
::  DONE
:: ================================================================
echo ================================================================
echo   DEPLOYMENT SUCCESSFUL  --  %DATE%  %TIME%
echo ================================================================
echo.
echo   Log     : %LOG_FILE%
echo   Backup  : %BACKUP_FILE%
echo   Rollback: docker run ... %ROLLBACK_TAG%
echo.
echo   WHAT TO TEST:
echo   1. Log in as SUPER_ADMIN
echo   2. Restaurant with blank owner: Edit Owner Info ^> Save
echo      =^> Popup shows new Login ID + Temp Password
echo   3. Resend Welcome Email on same restaurant ^> should succeed
echo   4. Log in as OWNER ^> Settings tab
echo      =^> "My Profile" section with email + mobile fields
echo.
call :LOG_ONLY "Deployment SUCCESSFUL at %TS%"
goto :END_OK

:: ================================================================
::  ROLLBACK OFFER
:: ================================================================
:OFFER_ROLLBACK
echo.
echo ================================================================
echo   DEPLOYMENT FAILED
echo ================================================================
echo.
echo   [1] Rollback to previous image: %ROLLBACK_TAG%
echo   [2] Skip -- investigate manually
echo.
set /p RB="Enter 1 or 2: "
if not "%RB%"=="1" goto :SKIP_ROLLBACK

echo.
call :INFO "Stopping and removing failed container..."
docker stop %APP_CONTAINER% >nul 2>&1
docker rm   %APP_CONTAINER% >nul 2>&1

call :INFO "Starting rollback image: %ROLLBACK_TAG%"
:: Re-tag rollback image back to :latest so docker compose up picks it up
docker tag %ROLLBACK_TAG% %APP_IMAGE%:latest >nul 2>&1
:: Use docker compose up — this always uses the correct network from docker-compose.yml
pushd "%APP_WIN_PATH%"
docker compose up -d app >> "%LOG_FILE%" 2>&1
set RB_ERR=%errorlevel%
popd

timeout /t 12 /nobreak >nul

if %RB_ERR% equ 0 (
    docker logs %APP_CONTAINER% --tail=5 2>&1 | findstr /C:"Server running" >nul 2>&1
    if %errorlevel% equ 0 (
        call :OK "ROLLBACK SUCCESSFUL -- previous version is running"
    ) else (
        call :WARN "Container started but startup not confirmed."
        call :INFO "Check: docker logs %APP_CONTAINER%"
    )
) else (
    call :FAIL "Rollback also failed. Run manually in CMD:"
    echo.
    echo   docker stop %APP_CONTAINER% ^& docker rm %APP_CONTAINER%
    echo   docker run -d --name %APP_CONTAINER% --restart always --env-file "%APP_WIN_PATH%\.env" -e PORT=5001 -p 5001:5001 -v atithi-setu_app_uploads:/app/public/uploads --network atithi-setu_default %ROLLBACK_TAG%
)
goto :AFTER_ROLLBACK

:SKIP_ROLLBACK
call :WARN "Rollback skipped. Check: docker logs %APP_CONTAINER% --tail=50"

:AFTER_ROLLBACK
call :LOG_ONLY "Deployment FAILED at %TS%"
echo.
echo Log: %LOG_FILE%
goto :END_FAIL

:: ================================================================
::  HELPERS
:: ================================================================
:OK
echo   [  OK  ] %~1
echo   [  OK  ] %~1 >> "%LOG_FILE%"
goto :eof

:FAIL
echo.
echo   [FAILED] %~1
echo   [FAILED] %~1 >> "%LOG_FILE%"
echo.
goto :eof

:WARN
echo   [ WARN ] %~1
echo   [ WARN ] %~1 >> "%LOG_FILE%"
goto :eof

:INFO
echo   [  ..  ] %~1
echo   [  ..  ] %~1 >> "%LOG_FILE%"
goto :eof

:LOG_ONLY
echo %~1 >> "%LOG_FILE%"
goto :eof

:END_OK
echo.
pause
exit /b 0

:END_CANCEL
echo.
pause
exit /b 0

:END_FAIL
echo.
pause
exit /b 1
