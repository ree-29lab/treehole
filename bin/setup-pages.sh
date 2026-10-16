#!/usr/bin/env bash
# 一次性设置：把项目推上 GitHub，并开启 GitHub Pages 作为固定入口页。
# 跑完会打印一个永远不变的分享链接。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

gh auth status >/dev/null 2>&1 || { echo "先 gh auth login 登录 GitHub。"; exit 1; }

# ---------- 1. 本地仓库 ----------
if [ ! -d .git ]; then
  git init -q -b main
  echo "建好了本地 git 仓库。"
fi

if [ -z "$(git config user.email || true)" ]; then
  EMAIL="$(gh api user --jq '.email // empty' 2>/dev/null || true)"
  [ -n "$EMAIL" ] || EMAIL="$(gh api user --jq '.login')@users.noreply.github.com"
  git config user.email "$EMAIL"
  git config user.name "$(gh api user --jq .login)"
  echo "给这个仓库设了提交身份：$EMAIL"
fi

git add -A
if git diff --cached --quiet; then
  echo "没有新东西要提交。"
else
  if git ls-files --cached | grep -qE '^(data|logs)/'; then
    echo "⚠️ data/ 或 logs/ 被加入了暂存区，那里面有口令，已中止。检查 .gitignore。"
    exit 1
  fi
  git commit -qm "树洞：本机服务 + Cloudflare 隧道 + GitHub Pages 入口页"
  echo "提交好了。"
fi

# ---------- 2. GitHub 仓库 ----------
if gh repo view "$PAGES_REPO" >/dev/null 2>&1; then
  echo "仓库 ${PAGES_REPO} 已经存在。"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/${PAGES_REPO}.git"
else
  gh repo create "$PAGES_REPO" --public --source=. --remote=origin \
    --description "A tiny anonymous message board you run from your own laptop"
  echo "建好了仓库 ${PAGES_REPO}（公开——Pages 免费版需要公开仓库）。"
fi

git push -u origin main

# ---------- 3. 开启 Pages ----------
if gh api "repos/${PAGES_REPO}/pages" >/dev/null 2>&1; then
  echo "Pages 已经开过了。"
else
  gh api -X POST "repos/${PAGES_REPO}/pages" \
    -f "source[branch]=main" -f "source[path]=/docs" >/dev/null
  echo "Pages 开好了（从 main 分支的 /docs 出）。"
fi

echo "等 GitHub 构建（一般一两分钟）…"
for _ in $(seq 1 20); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$PAGES_URL" || true)"
  [ "$CODE" = "200" ] && break
  sleep 6
done

echo
echo "固定入口页：$PAGES_URL"
echo "✅ 设置完成。以后只要跑 bin/start.sh，入口页会自动指向当前隧道地址。"
