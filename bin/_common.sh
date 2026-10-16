# 各脚本共用的路径与配置读取。
# 由 start.sh / stop.sh / setup-pages.sh 通过 source 引入。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="$(node -e "process.stdout.write(require('$ROOT/config/app.json').host)")"
PORT="$(node -e "process.stdout.write(String(require('$ROOT/config/app.json').port))")"

# 入口页仓库（GitHub Pages 从这里出）。想换成自己的仓库就改这一行。
PAGES_REPO="${TREEHOLE_PAGES_REPO:-ree-29lab/treehole}"
PAGES_OWNER="${PAGES_REPO%%/*}"
PAGES_NAME="${PAGES_REPO##*/}"
PAGES_URL="https://${PAGES_OWNER}.github.io/${PAGES_NAME}/"

LOCAL_URL="http://${HOST}:${PORT}"

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
# 换 gist 时这里和 docs/index.html 里的 NOW_URL 要一起改。
NOW_GIST_ID="${TREEHOLE_GIST_ID:-4f04245b3bf4abc77914dd26da2ba8cf}"

publish_now_json() {
  local url="$1" online="$2" json
  json="$(printf '{"url":"%s","online":%s,"updatedAt":"%s"}' "$url" "$online" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  gh api -X PATCH "gists/${NOW_GIST_ID}" -f "files[now.json][content]=${json}" >/dev/null
}
