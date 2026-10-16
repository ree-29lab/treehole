#!/usr/bin/env bash
# 看一眼现在什么状态：本机服务、入口页记录、隧道地址、分享链接、两个口令。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

if is_up; then
  printf '本机服务　　：在跑（%s）\n' "$LOCAL_URL"
else
  printf '本机服务　　：没跑（%s）\n' "$LOCAL_URL"
fi

STATE="$(gh api "gists/${NOW_GIST_ID}" --jq ".files[\"${NOW_GIST_FILE}\"].content" 2>/dev/null || true)"
if [ -n "$STATE" ]; then
  printf '入口页记录　：%s\n' "$(STATE="$STATE" node -e "const j=JSON.parse(process.env.STATE);process.stdout.write((j.online?'在线 ':'没开门 ')+(j.url||''))")"
else
  printf '入口页记录　：读不到（检查 gh 登录状态，或先跑 bin/setup.sh）\n'
fi

TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log 2>/dev/null | tail -1 || true)"
if [ -n "$TUNNEL_URL" ]; then
  if curl -sf -o /dev/null --max-time 10 "${TUNNEL_URL}/healthz"; then
    printf '隧道（本机记）：%s（通）\n' "$TUNNEL_URL"
  else
    printf '隧道（本机记）：%s（连不上）\n' "$TUNNEL_URL"
  fi
fi

printf '固定分享链接：%s#%s\n' "$PAGES_URL" "$(passphrase)"
printf '后台地址　　：%s/admin\n' "${TUNNEL_URL:-<当前公网地址>}"
printf '后台口令　　：%s\n' "$(admin_passphrase)"
printf '数据文件　　：%s\n' "$ROOT/data/treehole.db"
