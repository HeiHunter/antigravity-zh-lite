#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js，请先安装 Node.js >= 22：https://nodejs.org/"
  read -r -p "按回车键退出..."
  exit 1
fi
echo "=== 启动 Antigravity 2.0 轻量化汉化插件 (macOS) ==="
node ./bin/ag-zh.js --restart
