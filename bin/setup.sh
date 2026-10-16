#!/usr/bin/env bash
# 一次性设置：把这个树洞变成「你自己的、别人打得开的」站点。
#
#   bin/setup.sh                用默认仓库名 <你的 GitHub 用户名>/treehole
#   bin/setup.sh mysite         换一个仓库名
#   bin/setup.sh --yes          不再逐条问确认
#
# 会做：生成口令 → 放预置内容 → 建状态 gist → 建/推 GitHub 仓库 → 开 GitHub Pages
# 做完打印一条固定不变的分享链接。可以重复跑，已经做过的会跳过。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

ASSUME_YES=0
REPO_NAME="treehole"
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -*) echo "不认识的参数：$arg"; exit 1 ;;
    *) REPO_NAME="$arg" ;;
  esac
done

say() { printf '%s\n' "$*"; }
confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------- 1. 先看环境 ----------
command -v node >/dev/null 2>&1 || { say "没装 Node。先装 Node 24 或更新的版本：https://nodejs.org"; exit 1; }
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  say "Node 版本太低（现在是 $(node -v)），这个项目要用 24 以上。"
  exit 1
fi

command -v gh >/dev/null 2>&1 || { say "没装 gh（GitHub 命令行）。macOS：brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { say "先登录 GitHub：gh auth login"; exit 1; }
OWNER="$(gh api user --jq .login)"
REPO="${OWNER}/${REPO_NAME}"
PAGES_URL="https://${OWNER}.github.io/${REPO_NAME}/"

say "GitHub 账号：${OWNER}"
say "将要创建/使用公开仓库：${REPO}"
say "入口页会是：${PAGES_URL}"
say "（公开仓库是 GitHub Pages 免费版的要求。数据、口令都不在仓库里，只有代码和入口页。）"
confirm "继续吗？" || { say "好，什么都没动。"; exit 0; }

mkdir -p data logs

# ---------- 2. 口令 ----------
if [ -f data/secret.json ]; then
  say "口令已经有了：$(passphrase)"
else
  node --input-type=module -e "import('./src/config.js').then(m => m.loadConfig(process.cwd()))"
  say "生成好了口令：$(passphrase)"
  say "（后台口令：$(admin_passphrase)——只给你自己，别外发）"
fi

# ---------- 3. 预置内容 ----------
node scripts/seed.mjs

# ---------- 4. 状态 gist（入口页靠它知道当前地址） ----------
GIST_ID="$NOW_GIST_ID"
if [ -z "$GIST_ID" ]; then
  TMP_DIR="$(mktemp -d)"
  printf '{"url":"","online":false,"updatedAt":""}\n' > "${TMP_DIR}/now.json"
  GIST_URL="$(gh gist create --desc "树洞入口页状态：当前隧道地址（自动更新，别删）" "${TMP_DIR}/now.json" | tail -1)"
  GIST_ID="${GIST_URL##*/}"
  rm -rf "$TMP_DIR"
  say "建好状态 gist：${GIST_URL}"
else
  say "复用已有状态 gist：${GIST_ID}"
fi

node -e "
const fs = require('fs');
fs.writeFileSync('config/entry.json', JSON.stringify({
  pagesRepo: '${REPO}',
  gistId: '${GIST_ID}',
  gistFile: 'now.json'
}, null, 2) + '\n');
const page = 'docs/index.html';
let html = fs.readFileSync(page, 'utf8');
html = html.replace(/var GIST_ID = '[^']*';/, \"var GIST_ID = '${GIST_ID}';\");
html = html.replace(/var GIST_OWNER = '[^']*';/, \"var GIST_OWNER = '${OWNER}';\");
fs.writeFileSync(page, html);
"
say "已把仓库名和 gist 写进 config/entry.json 与 docs/index.html"

# ---------- 5. 本地 git 仓库 ----------
if [ ! -d .git ]; then
  git init -q -b main
  say "建好了本地 git 仓库。"
fi
if [ -z "$(git config user.email || true)" ]; then
  git config user.email "$(gh api user --jq '.email // empty' 2>/dev/null || echo "${OWNER}@users.noreply.github.com")"
  git config user.name "$OWNER"
fi
git add -A
if git ls-files --cached | grep -qE '^(data|logs)/'; then
  say "⚠️ data/ 或 logs/ 进了暂存区——那里面有口令。已中止，请检查 .gitignore。"
  exit 1
fi
if git diff --cached --quiet; then
  say "没有新东西要提交。"
else
  git commit -qm "树洞：初始化（服务 + 隧道 + 入口页）"
  say "提交好了。"
fi

# ---------- 6. 推上 GitHub ----------
if gh repo view "$REPO" >/dev/null 2>&1; then
  say "仓库 ${REPO} 已经存在。"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/${REPO}.git"
else
  gh repo create "$REPO" --public --source=. --remote=origin \
    --description "A tiny anonymous message board you run from your own laptop"
  say "建好了仓库 ${REPO}。"
fi

if git push -u origin main; then
  say "代码推上去了。"
else
  say "⚠️ git push 失败了（国内直连 github.com 经常超时）。"
  say "   可以稍后重试 git push，或者用 bin/push-via-api.sh 把文件直接写进仓库。"
fi

# ---------- 7. 开 Pages ----------
if gh api "repos/${REPO}/pages" >/dev/null 2>&1; then
  say "GitHub Pages 已经开过了。"
else
  gh api -X POST "repos/${REPO}/pages" -f "source[branch]=main" -f "source[path]=/docs" >/dev/null
  say "开好了 GitHub Pages（从 main 分支的 /docs 出）。"
fi

say ""
say "✅ 设置完成。"
say "   1) 让站点上线：bin/start.sh"
say "   2) 把这条固定链接发给人：${PAGES_URL}#$(passphrase)"
say "   3) 细节和排错看「操作手册.md」"
