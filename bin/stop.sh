#!/usr/bin/env bash
# 收摊：停服务、停隧道，并把入口页标记成「没开门」。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

if [ -f data/tunnel.pid ] && kill -0 "$(cat data/tunnel.pid)" 2>/dev/null; then
  kill "$(cat data/tunnel.pid)" 2>/dev/null || true
  echo "隧道停了。"
fi
rm -f data/tunnel.pid

if [ -f data/server.pid ] && kill -0 "$(cat data/server.pid)" 2>/dev/null; then
  kill "$(cat data/server.pid)" 2>/dev/null || true
  echo "服务停了。"
elif is_up; then
  echo "服务不是这个脚本起的，没动它（要停就自己找进程）。"
else
  echo "服务本来就没在跑。"
fi
rm -f data/server.pid

if gh auth status >/dev/null 2>&1 && gh repo view "$PAGES_REPO" >/dev/null 2>&1; then
  publish_now_json "" false && echo "入口页已标记为「没开门」。"
fi
