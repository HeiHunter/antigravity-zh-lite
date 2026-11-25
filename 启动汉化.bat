@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js ^>= 22：https://nodejs.org/
  pause
  exit /b 1
)

echo === 启动 Antigravity 2.0 轻量化汉化插件 (Windows) ===
echo 如需安装开机无黑框常驻，请运行：node bin\ag-zh.js install
echo.
node ".\bin\ag-zh.js" --restart
if errorlevel 1 pause
