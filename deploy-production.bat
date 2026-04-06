@echo off
setlocal enabledelayedexpansion
title Atithi Setu -- Production Deployment

:: ================================================================
::  ATITHI SETU — PRODUCTION DEPLOYMENT SCRIPT
::  Run this file on the PRODUCTION Windows machine to deploy
::  the latest changes from the dev folder.
::
::  What this script does (in order):
::    1.  Pre-flight checks (WSL2, Docker, paths)
::    2.  Take a database + uploads backup
::    3.  Tag current Docker image for rollback
::    4.  Copy changed files from dev folder to WSL2
::    5.  Verify the files were copied correctly
::    6.  Build new Docker image
::    7.  Restart the application container
::    8.  Verify the app started cleanly
::    9.  Run a quick health check
::    10. Done — show summary
::
::  On ANY failure the script stops and offers a one-click rollback.
:: ================================================================

:: ----------------------------------------------------------------
::  CONFIGURATION  — Edit these paths if they ever change
:: ----------------------------------------------------------------
set DEV_PATH=C:\Users\Admin\Documents\Workspace_MCS\dev-erp.athiti-setu\dev-erp
set WSL_DISTRO=Ubuntu-22.04
set WSL_APP_PATH=/opt/atithi-setu
set WSL_WIN_PATH=\\wsl$\Ubuntu-22.04\opt\atithi-setu
set APP_IMAGE=dev-erp-app
set APP_CONTAINER=node_app
set LOG_DIR=C:\atithi-setu\deploy-logs
:: ----------------------------------------------------------------

:: Create log directory if it does not exist
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Generate timestamp for this deployment (used in tag name + log file)
for /f "tokens=*" %%i in ('powershell -command "Get-Date -Format 'yyyyMMdd_HHmm'"') do set DEPLOY_TS=%%i
for /f "tokens=*" %%i in ('powershell -command "Get-Date -Format 'yyyyMMdd'"') do set DEPLOY_DATE=%%i

set LOG_FILE=%LOG_DIR%\deploy-%DEPLOY_TS%.log
set ROLLBACK_TAG=%APP_IMAGE%:pre-patch-%DEPLOY_DATE%

:: Print banner
echo.
call :PRINT_HEADER
echo.
call :LOG_ONLY "Deployment started at %DEPLOY_TS%"
call :LOG_ONLY "Dev source  : %DEV_PATH%"
call :LOG_ONLY "WSL2 target : %WSL_WIN_PATH%"
call :LOG_ONLY "Log file    : %LOG_FILE%"
echo Log file: %LOG_FILE%
echo.

:: ================================================================
::  STEP 1 — PRE-FLIGHT CHECKS
:: ================================================================
call :STEP "1" "Pre-flight checks"

:: Check WSL2 is available
wsl --status >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "WSL2 is not available on this machine. Please install WSL2 first (Section 0.2 of PRODUCTION_DEPLOY.md)."
    goto :END_FAIL
)
call :OK "WSL2 is available"

:: Check the WSL2 distro is running
wsl -d %WSL_DISTRO% -- bash -c "echo ok" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "WSL2 distro '%WSL_DISTRO%' is not running. Starting it now..."
    wsl -d %WSL_DISTRO% -- bash -c "echo started" >nul 2>&1
    timeout /t 5 /nobreak >nul
)
call :OK "WSL2 distro '%WSL_DISTRO%' is running"

:: Check Docker is accessible inside WSL2
wsl -d %WSL_DISTRO% -- bash -c "docker info" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Docker is not accessible inside WSL2. Make sure Docker Desktop is running and WSL2 integration is enabled."
    goto :END_FAIL
)
call :OK "Docker is running"

:: Check the deployment directory exists in WSL2
wsl -d %WSL_DISTRO% -- bash -c "test -d %WSL_APP_PATH%" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Deployment directory '%WSL_APP_PATH%' not found in WSL2. Has the application been deployed before?"
    goto :END_FAIL
)
call :OK "Deployment directory exists: %WSL_APP_PATH%"

:: Check source files exist on dev machine
if not exist "%DEV_PATH%\server.ts" (
    call :FAIL "Source file not found: %DEV_PATH%\server.ts"
    goto :END_FAIL
)
if not exist "%DEV_PATH%\src\App.tsx" (
    call :FAIL "Source file not found: %DEV_PATH%\src\App.tsx"
    goto :END_FAIL
)
call :OK "Source files found in dev folder"

:: Check WSL2 target directory is accessible from Windows
if not exist "%WSL_WIN_PATH%" (
    call :FAIL "Cannot access WSL2 path from Windows: %WSL_WIN_PATH%"
    call :INFO "Try running: wsl -d %WSL_DISTRO% -- bash -c 'ls /opt/atithi-setu'"
    goto :END_FAIL
)
call :OK "WSL2 path is accessible from Windows"

echo.

:: ================================================================
::  CONFIRMATION — Show what will be deployed
:: ================================================================
echo ================================================================
echo   FILES TO BE DEPLOYED:
echo.
echo   [1] server.ts   (owner upsert + resend email + profile API)
echo   [2] src\App.tsx (registration email status + My Profile UI)
echo.
echo   DESTINATION: %WSL_WIN_PATH%
echo ================================================================
echo.
set /p CONFIRM="Type YES to continue with deployment: "
if /i not "%CONFIRM%"=="YES" (
    echo.
    echo Deployment cancelled by user.
    call :LOG_ONLY "Deployment cancelled by user at confirmation prompt."
    goto :END_CANCEL
)
echo.

:: ================================================================
::  STEP 2 — TAKE BACKUP
:: ================================================================
call :STEP "2" "Taking database and uploads backup"

wsl -d %WSL_DISTRO% -- bash -c "%WSL_APP_PATH%/scripts/backup.sh" >> "%LOG_FILE%" 2>&1
if %errorlevel% neq 0 (
    call :WARN "Backup script returned an error. Check the log: %LOG_FILE%"
    echo.
    set /p BACKUP_SKIP="Backup may have failed. Type SKIP to continue anyway (risky), or press Enter to abort: "
    if /i not "!BACKUP_SKIP!"=="SKIP" (
        call :FAIL "Deployment aborted — fix the backup issue first."
        goto :END_FAIL
    )
    call :WARN "Skipping backup check at user request — PROCEEDING WITHOUT VERIFIED BACKUP"
) else (
    call :OK "Backup completed successfully"
)

:: Show backup file created
for /f "tokens=*" %%i in ('wsl -d %WSL_DISTRO% -- bash -c "ls -t /opt/backups/atithi-setu/*.tar.gz 2>/dev/null | head -1"') do set LATEST_BACKUP=%%i
if not "%LATEST_BACKUP%"=="" (
    call :INFO "Latest backup: %LATEST_BACKUP%"
)
echo.

:: ================================================================
::  STEP 3 — TAG CURRENT IMAGE FOR ROLLBACK
:: ================================================================
call :STEP "3" "Tagging current Docker image for rollback"

wsl -d %WSL_DISTRO% -- bash -c "docker tag %APP_IMAGE%:latest %ROLLBACK_TAG% 2>&1" >> "%LOG_FILE%" 2>&1
if %errorlevel% neq 0 (
    call :WARN "Could not tag existing image (may not exist yet — this is OK for first deployment)"
) else (
    call :OK "Rollback image saved as: %ROLLBACK_TAG%"
)
echo.

:: ================================================================
::  STEP 4 — COPY FILES
:: ================================================================
call :STEP "4" "Copying changed files to production"

:: Copy server.ts
call :INFO "Copying server.ts ..."
copy /Y "%DEV_PATH%\server.ts" "%WSL_WIN_PATH%\server.ts" >> "%LOG_FILE%" 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Failed to copy server.ts to WSL2. Check file permissions."
    goto :OFFER_ROLLBACK
)
call :OK "server.ts copied"

:: Copy App.tsx
call :INFO "Copying src\App.tsx ..."
copy /Y "%DEV_PATH%\src\App.tsx" "%WSL_WIN_PATH%\src\App.tsx" >> "%LOG_FILE%" 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Failed to copy src\App.tsx to WSL2. Check file permissions."
    goto :OFFER_ROLLBACK
)
call :OK "src\App.tsx copied"
echo.

:: ================================================================
::  STEP 5 — VERIFY FILES
:: ================================================================
call :STEP "5" "Verifying files were copied correctly"

:: Verify server.ts contains the new UPSERT logic
wsl -d %WSL_DISTRO% -- bash -c "grep -q 'No owner record found' %WSL_APP_PATH%/server.ts" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "server.ts verification failed — new owner upsert code not found. File may be corrupted or wrong version."
    goto :OFFER_ROLLBACK
)
call :OK "server.ts verification passed (owner upsert code present)"

:: Verify App.tsx contains the new profile section
wsl -d %WSL_DISTRO% -- bash -c "grep -q 'ownerProfile' %WSL_APP_PATH%/src/App.tsx" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "App.tsx verification failed — new ownerProfile code not found. File may be corrupted or wrong version."
    goto :OFFER_ROLLBACK
)
call :OK "App.tsx verification passed (owner profile section present)"
echo.

:: ================================================================
::  STEP 6 — BUILD DOCKER IMAGE
:: ================================================================
call :STEP "6" "Building new Docker image (this takes 3-5 minutes)"
call :INFO "Please wait — do not close this window..."
echo.

wsl -d %WSL_DISTRO% -- bash -c "cd %WSL_APP_PATH% && docker compose build --no-cache app" >> "%LOG_FILE%" 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Docker build FAILED. Check the build log:"
    echo.
    echo   Log file: %LOG_FILE%
    echo.
    call :INFO "Last 20 lines of build output:"
    wsl -d %WSL_DISTRO% -- bash -c "cd %WSL_APP_PATH% && docker compose build --no-cache app 2>&1 | tail -20"
    goto :OFFER_ROLLBACK
)
call :OK "Docker image built successfully"
echo.

:: ================================================================
::  STEP 7 — DEPLOY NEW IMAGE
:: ================================================================
call :STEP "7" "Starting new application container"

wsl -d %WSL_DISTRO% -- bash -c "cd %WSL_APP_PATH% && docker compose up -d app" >> "%LOG_FILE%" 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Failed to start application container."
    goto :OFFER_ROLLBACK
)

:: Wait for the container to fully start
call :INFO "Waiting 15 seconds for application to start..."
timeout /t 15 /nobreak >nul
echo.

:: ================================================================
::  STEP 8 — VERIFY STARTUP LOGS
:: ================================================================
call :STEP "8" "Verifying application started correctly"

:: Get the last 20 log lines from the app container
for /f "tokens=*" %%i in ('wsl -d %WSL_DISTRO% -- bash -c "docker compose -f %WSL_APP_PATH%/docker-compose.yml logs --tail=20 app 2>&1"') do (
    echo   %%i
    echo   %%i >> "%LOG_FILE%"
)
echo.

:: Check for the success startup message
wsl -d %WSL_DISTRO% -- bash -c "docker compose -f %WSL_APP_PATH%/docker-compose.yml logs --tail=30 app 2>&1 | grep -q 'Server running on'" >nul 2>&1
if %errorlevel% neq 0 (
    call :FAIL "Application did not start correctly — 'Server running on' message not found in logs."
    call :INFO "Check full logs with: wsl -d %WSL_DISTRO% -- bash -c 'docker compose -f %WSL_APP_PATH%/docker-compose.yml logs --tail=50 app'"
    goto :OFFER_ROLLBACK
)
call :OK "Application started successfully (Server running on port 5001)"
echo.

:: ================================================================
::  STEP 9 — HEALTH CHECK
:: ================================================================
call :STEP "9" "Running health check"

:: Check the API responds
wsl -d %WSL_DISTRO% -- bash -c "curl -s -o /dev/null -w '%%{http_code}' http://localhost:5001/api/public/restaurants" > "%TEMP%\hc_result.txt" 2>&1
set /p HC_STATUS=<"%TEMP%\hc_result.txt"
del "%TEMP%\hc_result.txt" >nul 2>&1

if "%HC_STATUS%"=="200" (
    call :OK "Health check passed — API responded with HTTP 200"
) else (
    call :WARN "Health check returned HTTP %HC_STATUS% (expected 200)"
    call :INFO "The app may still be starting. Check manually: curl http://localhost:5001/api/public/restaurants"
)

:: Check both containers are running
wsl -d %WSL_DISTRO% -- bash -c "docker compose -f %WSL_APP_PATH%/docker-compose.yml ps" >> "%LOG_FILE%" 2>&1
call :INFO "Container status:"
wsl -d %WSL_DISTRO% -- bash -c "docker compose -f %WSL_APP_PATH%/docker-compose.yml ps"
echo.

:: ================================================================
::  DONE
:: ================================================================
call :PRINT_SUCCESS
call :LOG_ONLY "Deployment completed successfully at %DEPLOY_TS%"
call :LOG_ONLY "Rollback image available as: %ROLLBACK_TAG%"
echo.
echo   Log saved to: %LOG_FILE%
echo.
echo   WHAT TO TEST NEXT:
echo   1. Open the app in browser and log in as SUPER_ADMIN
echo   2. Find a restaurant with blank owner info
echo   3. Click Edit Owner Info - fill in details - click Save
echo      =^> Should show popup with Login ID + Temp Password: Welcome@123
echo   4. Click Resend Welcome Email
echo      =^> Should show success or SMTP error (not "Owner not found")
echo   5. Log in as OWNER - go to Settings tab
echo      =^> Should see "My Profile" section with email + mobile fields
echo.
goto :END_OK

:: ================================================================
::  ROLLBACK OFFER
:: ================================================================
:OFFER_ROLLBACK
echo.
echo ================================================================
echo   DEPLOYMENT FAILED — ROLLBACK OPTIONS
echo ================================================================
echo.
echo   [1] Quick rollback — restore previous Docker image (recommended)
echo       Restores code only, database is NOT affected (~2 minutes)
echo.
echo   [2] Skip rollback — leave as-is and investigate manually
echo.
set /p ROLLBACK_CHOICE="Enter 1 to rollback, 2 to skip: "

if "%ROLLBACK_CHOICE%"=="1" (
    call :STEP "R" "Rolling back to previous image: %ROLLBACK_TAG%"

    wsl -d %WSL_DISTRO% -- bash -c "docker stop %APP_CONTAINER% 2>/dev/null; docker rm %APP_CONTAINER% 2>/dev/null" >nul 2>&1

    wsl -d %WSL_DISTRO% -- bash -c "docker run -d --name %APP_CONTAINER% --restart always --env-file %WSL_APP_PATH%/.env -e PORT=5001 -p 5001:5001 -v atithi-setu_app_uploads:/app/public/uploads --network atithi-setu_default %ROLLBACK_TAG%" >> "%LOG_FILE%" 2>&1

    if %errorlevel% neq 0 (
        call :FAIL "Rollback also failed. Manual intervention required."
        call :INFO "Run manually inside WSL2:"
        echo   docker stop %APP_CONTAINER%
        echo   docker rm %APP_CONTAINER%
        echo   docker run -d --name %APP_CONTAINER% --restart always --env-file %WSL_APP_PATH%/.env -e PORT=5001 -p 5001:5001 -v atithi-setu_app_uploads:/app/public/uploads --network atithi-setu_default %ROLLBACK_TAG%
    ) else (
        timeout /t 10 /nobreak >nul
        wsl -d %WSL_DISTRO% -- bash -c "docker logs %APP_CONTAINER% --tail=10 2>&1 | grep -q 'Server running'" >nul 2>&1
        if %errorlevel% equ 0 (
            call :OK "Rollback successful — previous version is running"
        ) else (
            call :WARN "Rollback container started but startup not confirmed. Check logs:"
            call :INFO "wsl -d %WSL_DISTRO% -- bash -c 'docker logs %APP_CONTAINER% --tail=20'"
        )
    )
) else (
    call :WARN "Rollback skipped. Application may be in a broken state."
    call :INFO "Investigate with: wsl -d %WSL_DISTRO% -- bash -c 'docker compose -f %WSL_APP_PATH%/docker-compose.yml logs --tail=50 app'"
)

call :LOG_ONLY "Deployment FAILED at %DEPLOY_TS%"
echo.
echo Log saved to: %LOG_FILE%
goto :END_FAIL

:: ================================================================
::  HELPER SUBROUTINES
:: ================================================================

:STEP
echo [STEP %~1] %~2
echo [STEP %~1] %~2 >> "%LOG_FILE%"
echo ----------------------------------------------------------------
goto :eof

:OK
echo   [OK] %~1
echo   [OK] %~1 >> "%LOG_FILE%"
goto :eof

:FAIL
echo.
echo   [FAILED] %~1
echo   [FAILED] %~1 >> "%LOG_FILE%"
echo.
goto :eof

:WARN
echo   [WARN] %~1
echo   [WARN] %~1 >> "%LOG_FILE%"
goto :eof

:INFO
echo   [..] %~1
echo   [..] %~1 >> "%LOG_FILE%"
goto :eof

:LOG_ONLY
echo %~1 >> "%LOG_FILE%"
goto :eof

:PRINT_HEADER
echo ================================================================
echo   ATITHI SETU  --  Production Deployment
echo   %DATE%  %TIME%
echo ================================================================
echo   Source : %DEV_PATH%
echo   Target : %WSL_WIN_PATH%
echo   Image  : %APP_IMAGE%
echo   Tag    : %ROLLBACK_TAG%
echo ================================================================
goto :eof

:PRINT_SUCCESS
echo ================================================================
echo   DEPLOYMENT SUCCESSFUL
echo   %DATE%  %TIME%
echo ================================================================
goto :eof

:END_OK
pause
exit /b 0

:END_CANCEL
pause
exit /b 0

:END_FAIL
pause
exit /b 1
