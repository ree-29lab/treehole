#!/usr/bin/env bash
# 用 GitHub Contents API 把工作区里指定的文件写进仓库（绕过连不上的 git push）。
#   bin/push-via-api.sh docs/index.html README.md
# 不带参数时，推送工作区里所有已跟踪、已改动的文件。
# 能 git push 的时候优先用 git；这个脚本只是国内网络下的替代路线。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REPO="$(git config --get remote.origin.url 2>/dev/null | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ -n "$REPO" ] || { echo "读不到 origin 远程地址，先跑 bin/setup.sh。"; exit 1; }

files=("$@")
if [ ${#files[@]} -eq 0 ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && files+=("$line")
  done < <(git status --porcelain | awk '{print $2}')
fi
[ ${#files[@]} -gt 0 ] || { echo "没有要推的文件。"; exit 0; }

for path in "${files[@]}"; do
  [ -f "$path" ] || { echo "跳过（不存在或已删除）：$path"; continue; }
  sha="$(gh api "repos/${REPO}/contents/${path}?ref=${BRANCH}" --jq .sha 2>/dev/null || true)"
  content="$(base64 < "$path" | tr -d '\n')"
  if [ -n "$sha" ]; then
    gh api -X PUT "repos/${REPO}/contents/${path}" \
      -f message="更新 ${path}" -f content="$content" -f sha="$sha" -f branch="$BRANCH" >/dev/null
  else
    gh api -X PUT "repos/${REPO}/contents/${path}" \
      -f message="新增 ${path}" -f content="$content" -f branch="$BRANCH" >/dev/null
  fi
  echo "已推送 $path"
done
