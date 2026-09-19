@echo off
setlocal enabledelayedexpansion
title Keyword Highlighter - auto update setup (Edge / Chrome)

rem ============================================================================
rem  Keyword Highlighter - install / auto-update / uninstall helper
rem  ---------------------------------------------------------------------------
rem  WHAT IT WRITES (per browser):
rem    1) HKLM\SOFTWARE\<vendor>\<browser>\Extensions\<ID>\update_url      <-- THE KEY
rem       (the legacy "external extension" key - this is what actually makes
rem        Edge/Chrome install the extension and keep it auto-updated)
rem    2) ...\Policies\<vendor>\<browser>\ExtensionInstallAllowlist\<slot>
rem       (non-store extensions must be allowlisted)
rem    3) ...\Policies\<vendor>\<browser>\ExtensionInstallForcelist\<slot>
rem       (Chrome: used; Edge: shows as [BLOCKED], harmless)
rem
rem  SLOTS: stable = 8, beta = 9. Other extensions' entries are NEVER touched.
rem
rem  UNINSTALL: deleting the Extensions key makes the browser REMOVE the
rem  extension on the next start. Your keywords live inside the extension's own
rem  storage, so EXPORT A BACKUP FIRST (options page -> import/export -> JSON).
rem
rem  NOTE: messages are English on purpose - a .bat with non-ASCII text breaks
rem  depending on the console codepage. Keep this file ASCII.
rem ============================================================================

set V_EDGE=Microsoft\Edge
set V_CHROME=Google\Chrome

set BETA_ID=ohjcaheamdifcldcofpblbejlpmgnhjc
set BETA_URL=https://moxiaoren.github.io/keyword-highlighter-extension/update-beta.xml
set STABLE_ID=kpakjonpfookjchkfinfhkojiamjcedj
set STABLE_URL=https://moxiaoren.github.io/keyword-highlighter-extension/update.xml
set STABLE_SLOT=8
set BETA_SLOT=9

if not "%~1"=="" set "NOPAUSE=1"
rem ---- command line shortcuts (no menu): status / install / remove ----
if /i "%~1"=="status"  goto do_status
if /i "%~1"=="remove"  goto do_remove
if /i "%~1"=="install" goto do_install_arg
if not "%~1"=="" goto usage

:menu
cls
echo.
echo  ==========================================================
echo   Keyword Highlighter - auto update setup
echo  ==========================================================
echo.
echo    INSTALL / ENABLE auto-update
echo      [1] Edge   + BETA        [2] Edge   + STABLE
echo      [3] Chrome + BETA        [4] Chrome + STABLE
echo      [5] Edge + Chrome + BETA (both browsers)
echo      [6] Everything (both browsers x BETA + STABLE)
echo.
echo    [7] UNINSTALL (remove all of our entries; extension is removed on
echo        the next browser start - BACK UP YOUR KEYWORDS FIRST)
echo    [8] STATUS
echo    [0] Exit
echo.
set /p "CH=  Choose: "
if "%CH%"=="1" call :need_admin edge beta
if "%CH%"=="2" call :need_admin edge stable
if "%CH%"=="3" call :need_admin chrome beta
if "%CH%"=="4" call :need_admin chrome stable
if "%CH%"=="5" call :need_admin both beta
if "%CH%"=="6" call :need_admin both all
if "%CH%"=="7" call :need_admin remove
if "%CH%"=="8" goto do_status
if "%CH%"=="0" exit /b 0
goto menu

rem ================================================================ elevation
:need_admin
net session >nul 2>&1
if not errorlevel 1 goto :elevated
echo.
echo  Admin rights are required (HKLM machine keys). Re-launching elevated...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%1','%2' -Verb RunAs" >nul 2>&1
exit /b 0
:elevated
set ACT=%~1
set CHN=%~2
if /i "%ACT%"=="remove" goto do_remove
if /i "%ACT%"=="edge"   call :install_chan %V_EDGE%   %CHN%
if /i "%ACT%"=="chrome" call :install_chan %V_CHROME% %CHN%
if /i "%ACT%"=="both" (
  call :install_chan %V_EDGE%   %CHN%
  call :install_chan %V_CHROME% %CHN%
)
echo.
echo  Done. Fully quit the browser (all windows) and start it again.
echo  - Chrome: chrome://policy   should list the entry WITHOUT [BLOCKED]
echo  - Edge  : edge://policy    may show [BLOCKED] (harmless) - what matters is
echo            that edge://extensions installs the extension and keeps updating it
echo  - Back up your keywords from the options page (import/export) if you plan
echo    to uninstall later.
echo.
if not defined NOPAUSE pause
if defined NOPAUSE exit /b 0
goto menu

rem ================================================================ install
rem %1 = vendor path, %2 = stable | beta | all
:install_chan
if /i "%~2"=="stable" call :write_one "%~1" "%STABLE_ID%" "%STABLE_URL%" %STABLE_SLOT% stable
if /i "%~2"=="beta"   call :write_one "%~1" "%BETA_ID%"   "%BETA_URL%"   %BETA_SLOT%   beta
if /i "%~2"=="all" (
  call :write_one "%~1" "%STABLE_ID%" "%STABLE_URL%" %STABLE_SLOT% stable
  call :write_one "%~1" "%BETA_ID%"   "%BETA_URL%"   %BETA_SLOT%   beta
)
goto :eof

:write_one
set "VEN=%~1"
set "EID=%~2"
set "EURL=%~3"
set "SLOT=%~4"
set "LABEL=%~5"
reg add "HKLM\SOFTWARE\%VEN%\Extensions\%EID%" /v update_url /t REG_SZ /d "%EURL%" /f >nul 2>&1
reg add "HKLM\SOFTWARE\WOW6432Node\%VEN%\Extensions\%EID%" /v update_url /t REG_SZ /d "%EURL%" /f >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\%VEN%\ExtensionInstallAllowlist" /v %SLOT% /t REG_SZ /d "%EID%" /f >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\%VEN%\ExtensionInstallForcelist" /v %SLOT% /t REG_SZ /d "%EID%;%EURL%" /f >nul 2>&1
echo   [OK] %VEN%  %LABEL%  (id=%EID%  slot=%SLOT%)
goto :eof

:do_install_arg
rem install <edge|chrome|both> <stable|beta|all>
if "%~2"=="" goto usage
net session >nul 2>&1
if not errorlevel 1 goto :elevated2
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'install','%~2','%~3' -Verb RunAs" >nul 2>&1
exit /b 0
:elevated2
set NOPAUSE=1
set ACT=%~2
set CHN=%~3
if /i "%ACT%"=="edge"   call :install_chan %V_EDGE%   %CHN%
if /i "%ACT%"=="chrome" call :install_chan %V_CHROME% %CHN%
if /i "%ACT%"=="both" (
  call :install_chan %V_EDGE%   %CHN%
  call :install_chan %V_CHROME% %CHN%
)
exit /b 0

rem ================================================================ uninstall
:do_remove
net session >nul 2>&1
if not errorlevel 1 goto :remove_go
echo.
echo  Admin rights are required. Re-launching elevated...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'remove' -Verb RunAs" >nul 2>&1
exit /b 0
:remove_go
echo.
echo  Removing our entries (other extensions are not touched)...
call :remove_one "%V_EDGE%"   "%STABLE_ID%"
call :remove_one "%V_EDGE%"   "%BETA_ID%"
call :remove_one "%V_CHROME%" "%STABLE_ID%"
call :remove_one "%V_CHROME%" "%BETA_ID%"
echo.
echo  Done. On the next browser start the extension is removed by the browser.
echo  IMPORTANT: this DELETES the extension's own storage (keywords/groups).
echo.
if not defined NOPAUSE pause
if defined NOPAUSE exit /b 0
goto menu

:remove_one
set "VEN=%~1"
set "EID=%~2"
reg delete "HKLM\SOFTWARE\%VEN%\Extensions\%EID%" /f >nul 2>&1
reg delete "HKLM\SOFTWARE\WOW6432Node\%VEN%\Extensions\%EID%" /f >nul 2>&1
call :del_value "HKLM\SOFTWARE\Policies\%VEN%\ExtensionInstallAllowlist" "%EID%"
call :del_value "HKLM\SOFTWARE\Policies\%VEN%\ExtensionInstallForcelist" "%EID%"
echo   [OK] %VEN%  cleaned (id=%EID%)
goto :eof

rem delete every value of %1 whose data contains %2  (snapshot first: never
rem delete while enumerating - that throws and can leave entries behind)
:del_value
set "KEY=%~1"
set "NEEDLE=%~2"
for /f "tokens=1,2,*" %%a in ('reg query "%KEY%" 2^>nul ^| findstr /i "REG_SZ"') do (
  echo %%c | findstr /i "%NEEDLE%" >nul && reg delete "%KEY%" /v %%a /f >nul 2>&1
)
goto :eof

rem ================================================================ status
:do_status
echo.
echo  ================ STATUS ================
for %%V in ("%V_EDGE%" "Google\Chrome") do (
  echo.
  echo  --- %%V ---
  for %%I in ("%STABLE_ID%" "ohjcaheamdifcldcofpblbejlpmgnhjc") do (
    reg query "HKLM\SOFTWARE\%%~V\Extensions\%%~I" /v update_url >nul 2>&1
    if errorlevel 1 (echo    %%~I  external key : NO) else (echo    %%~I  external key : YES)
  )
  reg query "HKLM\SOFTWARE\Policies\%%~V\ExtensionInstallAllowlist" >nul 2>&1
  if errorlevel 1 (echo    allowlist  : none) else (echo    allowlist  : & reg query "HKLM\SOFTWARE\Policies\%%~V\ExtensionInstallAllowlist" 2>nul | findstr /i "REG_SZ" | findstr /i "ohjcahea kpakjonp")
  reg query "HKLM\SOFTWARE\Policies\%%~V\ExtensionInstallForcelist" >nul 2>&1
  if errorlevel 1 (echo    forcelist  : none) else (echo    forcelist  : & reg query "HKLM\SOFTWARE\Policies\%%~V\ExtensionInstallForcelist" 2>nul | findstr /i "REG_SZ" | findstr /i "ohjcahea kpakjonp")
  echo    installed in profile :
  if exist "%LOCALAPPDATA%\%%~V\User Data\Default\Extensions\%STABLE_ID%" (echo      stable : YES) else (echo      stable : no)
  if exist "%LOCALAPPDATA%\%%~V\User Data\Default\Extensions\%BETA_ID%"   (echo      beta   : YES) else (echo      beta   : no)
)
echo.
echo  ========================================
echo.
if not defined NOPAUSE pause
if defined NOPAUSE exit /b 0
goto menu

:usage
echo.
echo  Usage: %~nx0 [status ^| remove ^| install ^<edge^|chrome^|both^> ^<stable^|beta^|all^>]
echo         (no arguments = interactive menu)
echo.
exit /b 1
