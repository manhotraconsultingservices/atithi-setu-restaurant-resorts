@echo off
setlocal EnableDelayedExpansion

:: ============================================================
::  Atithi-Setu — Docker Deployment Script (Windows)
::  Usage: Double-click or run from terminal: .\deploy.bat
:: ============================================================

title Atithi-Setu Deployment

:: Resolve script directory so it works from any location
cd /d "%~dp0"

:: ── Colour helpers (Windows 10+) ────────────────────────────
set "GREEN=[92m"
set "YELLOW=[93m"
set "RED=[91m"
set "CYAN=[96m"
set "BOLD=[1m"
set "RESET=[0m"

goto :MENU

:: ============================================================
:MENU
cls
echo %CYAN%
echo  ╔══════════════════════════════════════════════════╗
echo  ║         Atithi-Setu  ^|  Docker Manager          ║
echo  ║                  Port :  5001                    ║
echo  ╚══════════════════════════════════════════════════╝
echo %RESET%
echo  %BOLD%Select an action:%RESET%
echo.
echo   %GREEN%[1]%RESET%  Full Deploy          (build image + start all)
echo   %GREEN%[2]%RESET%  Rebuild ^& Deploy     (--no-cache, use after dependency changes)
echo   %GREEN%[3]%RESET%  Deploy Code Changes  (rebuild app only, keep DB running)
echo   %GREEN%[4]%RESET%  Restart App          (restart node_app container only)
echo   %GREEN%[5]%RESET%  View Live Logs       (Ctrl+C to exit log view)
echo   %GREEN%[6]%RESET%  Container Status     (show running containers + ports)
echo   %GREEN%[7]%RESET%  Stop All             (stop containers, keep volumes)
echo   %GREEN%[8]%RESET%  Full Teardown        (stop + remove containers ^& networks)
echo   %GREEN%[9]%RESET%  Backup Database      (dumps SQL to ./backups/)
echo   %GREEN%[0]%RESET%  Exit
echo.
set /p "CHOICE= Enter choice [0-9]: "

if "%CHOICE%"=="1" goto :FULL_DEPLOY
if "%CHOICE%"=="2" goto :REBUILD_DEPLOY
if "%CHOICE%"=="3" goto :DEPLOY_CODE
if "%CHOICE%"=="4" goto :RESTART_APP
if "%CHOICE%"=="5" goto :LOGS
if "%CHOICE%"=="6" goto :STATUS
if "%CHOICE%"=="7" goto :STOP
if "%CHOICE%"=="8" goto :TEARDOWN
if "%CHOICE%"=="9" goto :BACKUP
if "%CHOICE%"=="0" goto :EOF

echo %RED%Invalid choice. Please enter a number from 0 to 9.%RESET%
timeout /t 2 >nul
goto :MENU


:: ============================================================
:FULL_DEPLOY
echo.
echo %CYAN%[DEPLOY] Starting full deploy on port 5001...%RESET%
call :CHECK_ENV
call :CHECK_DOCKER
echo %YELLOW%[1/3] Pulling latest base images...%RESET%
docker compose pull db 2>nul
echo %YELLOW%[2/3] Building application image...%RESET%
docker compose build
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Build failed. Check output above.%RESET%
    goto :PAUSE_RETURN
)
echo %YELLOW%[3/3] Starting all containers...%RESET%
docker compose up -d
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Failed to start containers.%RESET%
    goto :PAUSE_RETURN
)
call :SHOW_STATUS
echo.
echo %GREEN%[OK] Deployment complete!%RESET%
echo %GREEN%     App is running at: http://localhost:5001%RESET%
goto :PAUSE_RETURN


:: ============================================================
:REBUILD_DEPLOY
echo.
echo %CYAN%[REBUILD] Full rebuild (no-cache) on port 5001...%RESET%
echo %YELLOW%This discards all cached layers. Takes longer but ensures a clean image.%RESET%
echo.
call :CHECK_ENV
call :CHECK_DOCKER
echo %YELLOW%[1/3] Stopping existing containers...%RESET%
docker compose down --remove-orphans
echo %YELLOW%[2/3] Building from scratch (--no-cache)...%RESET%
docker compose build --no-cache
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Build failed. Check output above.%RESET%
    goto :PAUSE_RETURN
)
echo %YELLOW%[3/3] Starting all containers...%RESET%
docker compose up -d
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Failed to start containers.%RESET%
    goto :PAUSE_RETURN
)
call :SHOW_STATUS
echo.
echo %GREEN%[OK] Clean rebuild complete!%RESET%
echo %GREEN%     App is running at: http://localhost:5001%RESET%
goto :PAUSE_RETURN


:: ============================================================
:DEPLOY_CODE
echo.
echo %CYAN%[CODE DEPLOY] Rebuilding app only (DB stays running)...%RESET%
echo %YELLOW%Use this after changing src/, server.ts, or other app files.%RESET%
echo.
call :CHECK_DOCKER
echo %YELLOW%[1/3] Stopping app container only...%RESET%
docker compose stop app
echo %YELLOW%[2/3] Rebuilding app image (with cache)...%RESET%
docker compose build app
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Build failed. Check output above.%RESET%
    goto :PAUSE_RETURN
)
echo %YELLOW%[3/3] Starting updated app container...%RESET%
docker compose up -d app
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Failed to start app container.%RESET%
    goto :PAUSE_RETURN
)
echo.
echo %YELLOW%Waiting for app to start...%RESET%
timeout /t 5 >nul
call :SHOW_STATUS
echo.
echo %GREEN%[OK] Code deploy complete!%RESET%
echo %GREEN%     App is running at: http://localhost:5001%RESET%
goto :PAUSE_RETURN


:: ============================================================
:RESTART_APP
echo.
echo %CYAN%[RESTART] Restarting node_app container...%RESET%
call :CHECK_DOCKER
docker compose restart app
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Could not restart. Is the container running?%RESET%
    goto :PAUSE_RETURN
)
echo %YELLOW%Waiting for app to restart...%RESET%
timeout /t 4 >nul
call :SHOW_STATUS
echo.
echo %GREEN%[OK] App restarted at: http://localhost:5001%RESET%
goto :PAUSE_RETURN


:: ============================================================
:LOGS
echo.
echo %CYAN%[LOGS] Streaming logs (press Ctrl+C to stop)...%RESET%
echo.
docker compose logs -f --tail=50
goto :PAUSE_RETURN


:: ============================================================
:STATUS
echo.
call :SHOW_STATUS
goto :PAUSE_RETURN


:: ============================================================
:STOP
echo.
echo %CYAN%[STOP] Stopping containers (volumes are preserved)...%RESET%
docker compose stop
echo %GREEN%[OK] Containers stopped. Your database data is safe.%RESET%
goto :PAUSE_RETURN


:: ============================================================
:TEARDOWN
echo.
echo %YELLOW%[WARNING] This will stop and REMOVE all containers and networks.%RESET%
echo %YELLOW%          Your database VOLUME (pg_data) will be preserved.%RESET%
echo.
set /p "CONFIRM= Type YES to confirm teardown: "
if /i not "%CONFIRM%"=="YES" (
    echo %YELLOW%Cancelled.%RESET%
    goto :PAUSE_RETURN
)
docker compose down --remove-orphans
echo %GREEN%[OK] Teardown complete. Run option [1] to redeploy.%RESET%
goto :PAUSE_RETURN


:: ============================================================
:BACKUP
echo.
echo %CYAN%[BACKUP] Creating PostgreSQL dump...%RESET%
call :CHECK_DOCKER

:: Create backups directory if it doesn't exist
if not exist "backups" mkdir backups

:: Generate timestamp for filename
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DATETIME=%%I
set TIMESTAMP=%DATETIME:~0,4%-%DATETIME:~4,2%-%DATETIME:~6,2%__%DATETIME:~8,2%-%DATETIME:~10,2%-%DATETIME:~12,2%
set BACKUP_FILE=backups\atithi_setu_%TIMESTAMP%.sql

echo %YELLOW%Dumping database to: %BACKUP_FILE%%RESET%

:: Read DB credentials from .env
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="PGUSER"     set PGUSER=%%B
    if "%%A"=="PGDATABASE" set PGDATABASE=%%B
)

docker compose exec -T db pg_dump -U %PGUSER% %PGDATABASE% > "%BACKUP_FILE%"
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Backup failed. Is the db container running?%RESET%
    if exist "%BACKUP_FILE%" del "%BACKUP_FILE%"
    goto :PAUSE_RETURN
)
echo %GREEN%[OK] Backup saved to: %BACKUP_FILE%%RESET%

:: List recent backups
echo.
echo %YELLOW%Recent backups:%RESET%
dir /b /o-d backups\*.sql 2>nul | findstr /n "." | findstr "^[1-5]:"
goto :PAUSE_RETURN


:: ============================================================
:: HELPERS
:: ============================================================

:CHECK_ENV
if not exist ".env" (
    echo %RED%[ERROR] .env file not found!%RESET%
    echo %YELLOW%        Copy .env.example to .env and fill in your values:%RESET%
    echo          copy .env.example .env
    pause
    exit /b 1
)
exit /b 0

:CHECK_DOCKER
docker info >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[ERROR] Docker is not running.%RESET%
    echo %YELLOW%        Please start Docker Desktop and try again.%RESET%
    pause
    exit /b 1
)
exit /b 0

:SHOW_STATUS
echo.
echo %BOLD%Container Status:%RESET%
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>nul
exit /b 0

:PAUSE_RETURN
echo.
pause
goto :MENU
