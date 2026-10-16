# 各脚本共用的路径与配置读取。
# 由 start.sh / stop.sh / setup.sh 通过 source 引入。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="$(node -e "process.stdout.write(require('$ROOT/config/app.json').host)")"
PORT="$(node -e "process.stdout.write(String(require('$ROOT/config/app.json').port))")"
LOCAL_URL="http://${HOST}:${PORT}"

entry_value() {
  node -e "try{const c=require('$ROOT/config/entry.json');const v=c['$1'];process.stdout.write(v==null?'':String(v))}catch(e){}" 2>/dev/null || true
}

# 入口页仓库与状态 gist：都记在 config/entry.json 里，bin/setup.sh 会自动写好。
# 想手动换，改那个文件即可（或临时用 TREEHOLE_PAGES_REPO / TREEHOLE_GIST_ID 覆盖）。
PAGES_REPO="${TREEHOLE_PAGES_REPO:-$(entry_value pagesRepo)}"
if [ -z "$PAGES_REPO" ]; then
  PAGES_REPO="$(gh api user --jq .login 2>/dev/null || echo '')/treehole"
fi
PAGES_OWNER="${PAGES_REPO%%/*}"
PAGES_NAME="${PAGES_REPO##*/}"
PAGES_URL="https://${PAGES_OWNER}.github.io/${PAGES_NAME}/"

NOW_GIST_ID="${TREEHOLE_GIST_ID:-$(entry_value gistId)}"
NOW_GIST_FILE="$(entry_value gistFile)"
[ -n "$NOW_GIST_FILE" ] || NOW_GIST_FILE="now.json"

passphrase() {
  if [ -f "$ROOT/data/secret.json" ]; then
    node -e "process.stdout.write(require('$ROOT/data/secret.json').passphrase)"
  fi
}

admin_passphrase() {
  if [ -f "$ROOT/data/secret.json" ]; then
    node -e "process.stdout.write(require('$ROOT/data/secret.json').adminPassphrase)"
  fi
}

is_up() {
  curl -sf "${LOCAL_URL}/healthz" >/dev/null 2>&1
}

# 入口页的状态（当前隧道地址）放在一个 secret gist 里。
# 走 api.github.com，比 git push 稳（git 到 github.com:443 在国内经常连不上）。
publish_now_json() {
  local url="$1" online="$2" json
  if [ -z "$NOW_GIST_ID" ]; then
    echo "还没建状态 gist，先跑一次 bin/setup.sh。" >&2
    return 1
  fi
  json="$(printf '{"url":"%s","online":%s,"updatedAt":"%s"}' "$url" "$online" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  gh api -X PATCH "gists/${NOW_GIST_ID}" -f "files[${NOW_GIST_FILE}][content]=${json}" >/dev/null
}
