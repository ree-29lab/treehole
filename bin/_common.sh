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

# 把当前隧道地址写进入口页仓库的 docs/now.json，访客打开固定链接就能被带过来。
publish_now_json() {
  local url="$1" online="$2" sha json payload
  json="$(printf '{"url":"%s","online":%s,"updatedAt":"%s"}' "$url" "$online" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  payload="$(printf '%s' "$json" | base64 | tr -d '\n')"
  sha="$(gh api "repos/${PAGES_REPO}/contents/docs/now.json" --jq .sha 2>/dev/null || true)"
  if [ -n "$sha" ]; then
    gh api -X PUT "repos/${PAGES_REPO}/contents/docs/now.json" \
      -f message="tunnel ${online}" -f content="$payload" -f sha="$sha" -f branch=main >/dev/null
  else
    gh api -X PUT "repos/${PAGES_REPO}/contents/docs/now.json" \
      -f message="tunnel ${online}" -f content="$payload" -f branch=main >/dev/null
  fi
}
