@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
title 关键词高亮 - 安装与自动更新配置

rem ============================================================================
rem  关键词高亮 · 自动安装 / 自动更新 / 卸载 配置脚本
rem  ---------------------------------------------------------------------------
rem  每个浏览器写三样（第 1 个才是真正生效的关键）：
rem    1) HKLM\SOFTWARE\<厂商>\<浏览器>\Extensions\<ID>\update_url   << 关键
rem       「传统外部扩展」键 —— 实测在 Edge 与 Chrome 上都能让浏览器
rem       自动安装本扩展、并持续自动更新（Edge 的 Forcelist 会显示 [BLOCKED]
rem       但无害，真正生效的是这个键）
rem    2) ...\Policies\<厂商>\<浏览器>\ExtensionInstallAllowlist\<槽位>
rem       非商店扩展必须进白名单，否则会被拒绝安装
rem    3) ...\Policies\<厂商>\<浏览器>\ExtensionInstallForcelist\<槽位>
rem       Chrome 有效；Edge 显示 [BLOCKED]，留着无害
rem
rem  槽位约定：8 = 稳定版，9 = 测试版。其它扩展的条目绝不会被改动。
rem
rem  卸载：删除 Extensions 键后，浏览器下次启动会自动移除该扩展。
rem  注意：卸载会清空扩展自己的数据（关键词/分组），请先到设置页导出 JSON 备份。
rem
rem  编码说明：本文件是 GBK(cp936) + CRLF。中文 bat 必须这样存，否则 cmd 会解析错乱。
rem  写法注意：不要在 for 块里用 if errorlevel —— 它按"解析时"取值，
rem            要按每次执行判断必须用 && / || 。
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

if /i "%~1"=="status"  goto do_status
if /i "%~1"=="remove"  goto do_remove
if /i "%~1"=="install" goto do_install_arg
if not "%~1"=="" goto usage

:menu
cls
echo.
echo  ==========================================================
echo   关键词高亮 · 安装与自动更新配置
echo  ==========================================================
echo.
echo    安装 / 开启自动更新：
echo      [1] Edge   + 测试版          [2] Edge   + 稳定版
echo      [3] Chrome + 测试版          [4] Chrome + 稳定版
echo      [5] Edge 与 Chrome 都装 测试版
echo      [6] 全部（两个浏览器 × 稳定版 + 测试版）
echo.
echo    其它：
echo      [7] 卸载（移除本扩展的全部条目，浏览器下次启动会移除扩展）
echo      [8] 查看当前状态
echo      [0] 退出
echo.
echo    提示：卸载会清空扩展自己的数据（关键词/分组），请先导出 JSON 备份。
echo.
set /p "CH=  请选择："
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

rem ================================================================ 提权
:need_admin
net session >nul 2>&1
if not errorlevel 1 goto :elevated
echo.
echo  写机器级注册表需要管理员权限，正在请求提权（弹出窗口请点“是”）...
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
echo  完成。请【完全退出浏览器】（所有窗口）再重新打开。
echo    Chrome：chrome://policy 里该条目应不带 [BLOCKED]
echo    Edge  ：edge://policy 里可能显示 [BLOCKED]，这是正常的，不影响使用；
echo            看 edge://extensions 是否自动装上、版本能否随线上发版自动升级
echo.
if not defined NOPAUSE pause
if defined NOPAUSE exit /b 0
goto menu

rem ================================================================ 安装
rem %1 = 厂商路径  %2 = stable / beta / all
:install_chan
if /i "%~2"=="stable" call :write_one "%~1" "%STABLE_ID%" "%STABLE_URL%" %STABLE_SLOT% 稳定版
if /i "%~2"=="beta"   call :write_one "%~1" "%BETA_ID%"   "%BETA_URL%"   %BETA_SLOT%   测试版
if /i "%~2"=="all" (
  call :write_one "%~1" "%STABLE_ID%" "%STABLE_URL%" %STABLE_SLOT% 稳定版
  call :write_one "%~1" "%BETA_ID%"   "%BETA_URL%"   %BETA_SLOT%   测试版
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
echo   [OK] %VEN%  %LABEL%  已写入（槽位 %SLOT%）
goto :eof

:do_install_arg
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

rem ================================================================ 卸载
:do_remove
net session >nul 2>&1
if not errorlevel 1 goto :remove_go
echo.
echo  需要管理员权限，正在请求提权...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'remove' -Verb RunAs" >nul 2>&1
exit /b 0
:remove_go
echo.
echo  正在移除本扩展的全部条目（其它扩展不受影响）...
call :remove_one "%V_EDGE%"   "%STABLE_ID%"
call :remove_one "%V_EDGE%"   "%BETA_ID%"
call :remove_one "%V_CHROME%" "%STABLE_ID%"
call :remove_one "%V_CHROME%" "%BETA_ID%"
echo.
echo  完成。浏览器下次启动时会移除该扩展。
echo  重要：这会删除扩展自己的数据（关键词/分组），请提前导出 JSON 备份。
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
echo   [OK] %VEN%  已清理
goto :eof

rem 删除 %1 这个键下所有"数据里含 %2"的值（先取快照再删 —— 边遍历边删会报错并残留）
:del_value
set "KEY=%~1"
set "NEEDLE=%~2"
for /f "tokens=1,2,*" %%a in ('reg query "%KEY%" 2^>nul ^| findstr /i "REG_SZ"') do (
  echo %%c | findstr /i "%NEEDLE%" >nul && reg delete "%KEY%" /v %%a /f >nul 2>&1
)
goto :eof

rem ================================================================ 状态
rem 注意：这里刻意**不用** for + if errorlevel（那是解析时取值，会全判成同一分支），
rem       改用 && / || 按每次执行判断。
:do_status
echo.
echo  ================= 当前状态 =================
echo.
echo  --- Edge（Microsoft\Edge）---
call :show_one "Microsoft\Edge"
echo.
echo  --- Chrome（Google\Chrome）---
call :show_one "Google\Chrome"
echo.
echo  ============================================
echo.
if not defined NOPAUSE pause
if defined NOPAUSE exit /b 0
goto menu

:show_one
set "VEN=%~1"
reg query "HKLM\SOFTWARE\%VEN%\Extensions\%STABLE_ID%" /v update_url >nul 2>&1 && (echo    稳定版 关键键 update_url ：有) || (echo    稳定版 关键键 update_url ：无)
reg query "HKLM\SOFTWARE\%VEN%\Extensions\%BETA_ID%"   /v update_url >nul 2>&1 && (echo    测试版 关键键 update_url ：有) || (echo    测试版 关键键 update_url ：无)
echo    白名单：
reg query "HKLM\SOFTWARE\Policies\%VEN%\ExtensionInstallAllowlist" 2>nul | findstr /i "REG_SZ" | findstr /i "ohjcahea kpakjonp"
echo    强装列表：
reg query "HKLM\SOFTWARE\Policies\%VEN%\ExtensionInstallForcelist" 2>nul | findstr /i "REG_SZ" | findstr /i "ohjcahea kpakjonp"
echo    已装入浏览器配置目录：
if exist "%LOCALAPPDATA%\%VEN%\User Data\Default\Extensions\%STABLE_ID%" (echo       稳定版：已安装) else (echo       稳定版：未安装)
if exist "%LOCALAPPDATA%\%VEN%\User Data\Default\Extensions\%BETA_ID%"   (echo       测试版：已安装) else (echo       测试版：未安装)
goto :eof

:usage
echo.
echo  用法：%~nx0 [status ^| remove ^| install ^<edge^|chrome^|both^> ^<stable^|beta^|all^>]
echo        不带参数 = 打开菜单
echo.
exit /b 1
