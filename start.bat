@echo off
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\chcp.com" 65001 >nul 2>nul

rem 找 Node.js：先看 PATH，找不到再看常見的安裝位置
set "NODE="
for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE goto nonode

rem 伺服器準備好之後會自己打開瀏覽器
"%NODE%" server.js --open
if errorlevel 1 goto failed
exit /b 0

:nonode
echo.
echo   找不到 Node.js，遊戲沒辦法啟動。
echo   請到 https://nodejs.org 安裝 Node.js（選 LTS 版），裝好後再雙擊一次 start.bat。
echo.
pause
exit /b 1

:failed
echo.
echo   遊戲伺服器沒有正常啟動，上面是錯誤訊息。
echo.
pause
exit /b 1
