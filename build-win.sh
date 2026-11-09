#!/usr/bin/env bash
# 打 Windows NSIS 安装包（需要主机已装 wine32）
#
# 前置条件检查：
#   dpkg -l wine32        # 应该能看到 ii  wine32   ... i386
#   /usr/lib/wine/wine --version   # 应输出 wine-x.y.z（不是"段错误"）
#
# 用法：
#   bash ~/software/free-koodo-reader/build-win.sh          # 完整构建
#   bash ~/software/free-koodo-reader/build-win.sh --fast   # 跳过前端编译（build/ 已最新）
set -uo pipefail

cd "$(dirname "$0")" || exit 1

# electron-builder 会把 node_modules 复制到 $TMPDIR 再打 asar；
# 若 /tmp 是小的 tmpfs 就会 ENOSPC，这里统一指到大盘目录。
export TMPDIR=/home/todd/tmp
mkdir -p "$TMPDIR"

echo "== 环境自检 =="
if wine --version >/dev/null 2>&1; then
  echo "wine:  $(wine --version 2>/dev/null)"
else
  echo "!! wine 不可用。electron-builder 打 NSIS 需要 32 位 wine："
  echo "   sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install -y wine32"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "!! node_modules 缺失，先跑 npm install"
  exit 1
fi

if [ "${1:-}" != "--fast" ]; then
  echo "== 1/2 编译前端 =="
  npm run build || exit 1
else
  echo "== 1/2 跳过前端编译（--fast）=="
  [ -f build/index.html ] || { echo "!! build/index.html 不存在，去掉 --fast 重跑"; exit 1; }
fi

echo "== 2/2 打 Windows NSIS 安装包 =="
npx electron-builder --win nsis --x64 2>&1 | tail -25

echo "== 产物 =="
ls -lh dist/*.exe dist/*.zip 2>/dev/null
