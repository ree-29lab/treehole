#!/usr/bin/env bash
# 只重启树洞本体，不动隧道 —— 所以当前公网地址和分享链接都不变。
# 改了代码、改了口令、改了 config/*.json 之后跑这个。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

mkdir -p data logs

if [ -f data/server.pid ] && kill -0 "$(cat data/server.pid)" 2>/dev/null; then
  kill "$(cat data/server.pid)" 2>/dev/null || true
  sleep 1
elif is_up; then
  echo "服务不是这个脚本起的，先自己停掉它再跑这里。"
  exit 1
fi

nohup node server.js >> logs/server.log 2>&1 &
echo $! > data/server.pid
for _ in $(seq 1 30); do is_up && break; sleep 0.5; done

if is_up; then
  echo "重启好了（pid $(cat data/server.pid)）：$LOCAL_URL"
else
  echo "起不来，看看 logs/server.log："
  tail -20 logs/server.log || true
  exit 1
fi
