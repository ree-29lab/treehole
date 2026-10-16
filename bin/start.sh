#!/usr/bin/env bash
# 启动树洞：本机服务 → Cloudflare 隧道 → 更新 GitHub Pages 入口页。
#
#   bin/start.sh                 正常启动（带公网隧道）
#   bin/start.sh --no-tunnel     只在本机跑，不给外面开门
#   bin/start.sh --keep-awake    顺带禁止 Mac 睡觉（12 小时内有效）
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

WITH_TUNNEL=1
KEEP_AWAKE=0
for arg in "$@"; do
  case "$arg" in
    --no-tunnel) WITH_TUNNEL=0 ;;
    --keep-awake) KEEP_AWAKE=1 ;;
    *) echo "不认识的参数：$arg"; exit 1 ;;
  esac
done

mkdir -p data logs

# ---------- 1. 本机服务 ----------
if is_up; then
  echo "服务已经在跑了：$LOCAL_URL"
else
  nohup node server.js >> logs/server.log 2>&1 &
  echo $! > data/server.pid
  for _ in $(seq 1 30); do is_up && break; sleep 0.5; done
  if is_up; then
    echo "服务启动了（pid $(cat data/server.pid)）：$LOCAL_URL"
  else
    echo "服务没起来，看看 logs/server.log："
    tail -20 logs/server.log || true
    exit 1
  fi
fi

if [ "$KEEP_AWAKE" = "1" ]; then
  nohup caffeinate -is -t 43200 >/dev/null 2>&1 &
  echo "已让 Mac 在 12 小时内不睡（合盖还是会断）。"
fi

if [ "$WITH_TUNNEL" = "0" ]; then
  echo
  echo "🌳 只在本机跑，别人打不开。"
  echo "   本机地址：$LOCAL_URL"
  echo "   本机直连链接：$LOCAL_URL/?k=$(passphrase)"
  echo "   管理后台：$LOCAL_URL/admin（口令 $(admin_passphrase)）"
  echo "   要给别人开门就去掉 --no-tunnel。"
  exit 0
fi

# ---------- 2. 隧道 ----------
case "$(uname -m)" in
  arm64) CF_ASSET="cloudflared-darwin-arm64.tgz" ;;
  x86_64) CF_ASSET="cloudflared-darwin-amd64.tgz" ;;
  *) echo "不认识的 CPU 架构：$(uname -m)"; exit 1 ;;
esac

if [ ! -x bin/cloudflared ]; then
  echo "第一次要下载 cloudflared（约 20MB，从 GitHub 官方发布页拿）…"
  curl -fsSL -o data/cloudflared.tgz \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/${CF_ASSET}"
  tar -xzf data/cloudflared.tgz -C bin
  chmod +x bin/cloudflared
  rm -f data/cloudflared.tgz
fi

if [ -f data/tunnel.pid ] && kill -0 "$(cat data/tunnel.pid)" 2>/dev/null; then
  kill "$(cat data/tunnel.pid)" 2>/dev/null || true
  sleep 1
fi

: > logs/tunnel.log
nohup bin/cloudflared tunnel --url "$LOCAL_URL" --no-autoupdate >> logs/tunnel.log 2>&1 &
echo $! > data/tunnel.pid

TUNNEL_URL=""
for _ in $(seq 1 45); do
  TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | head -1 || true)"
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "隧道没起来，看看 logs/tunnel.log："
  tail -20 logs/tunnel.log || true
  exit 1
fi
echo "公网隧道开了：$TUNNEL_URL（每次重启都会换一个，入口页会自动跟过去）"

# ---------- 3. 入口页 ----------
if gh auth status >/dev/null 2>&1 && gh repo view "$PAGES_REPO" >/dev/null 2>&1; then
  if publish_now_json "$TUNNEL_URL" true; then
    echo "入口页已指向新地址：$PAGES_URL"
  else
    echo "入口页更新失败（不影响本机使用，检查 gh 登录）"
  fi
else
  echo "还没有入口页仓库，先跑一次 bin/setup-pages.sh 就能拿到固定链接。"
fi

# ---------- 4. 交钥匙 ----------
SHARE_PHRASE="$(passphrase)"
echo
echo "🌳 树洞在跑"
echo "   公网地址：$TUNNEL_URL"
echo "   本机地址：$LOCAL_URL"
if [ -n "$SHARE_PHRASE" ]; then
  echo "   口令：$SHARE_PHRASE"
  echo "   分享链接：${PAGES_URL}#${SHARE_PHRASE}"
  echo "   （这条链接固定不变，把整条发给朋友就行；链接里带着口令）"
fi
echo "   管理后台：把上面公网地址后面加上 /admin，口令是 $(admin_passphrase)"
echo "   注意：Mac 关机、合盖或断网，外面就打不开了。"
