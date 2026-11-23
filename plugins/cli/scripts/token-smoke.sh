#!/usr/bin/env bash
set -euo pipefail

usage="usage: token-smoke.sh <Ardia.app> <ardia command> [metro host:port]
Runs ardia browse read, open and cookies (read from 0.2.49, refused by name before) against a hidden instance of <Ardia.app> over the real token
connection (no DevTools port), with the given ardia command. A Debug build needs its Metro as the third argument.
Needs an ardia checkout for its instance helpers: \$ARDIA_REPO, else the checkout this plugins repo is a submodule of."
case "${1:-}" in -h | --help | "") echo "$usage"; [ -n "${1:-}" ] && exit 0 || exit 64 ;; esac
app="$(cd "$1" && pwd -P)"
cli="${2:?$usage}"
metro="${3:-}"
case "$app" in /Applications/*) echo "error: never an installed app" >&2; exit 1 ;; esac
here="$(cd "$(dirname "$0")/.." && pwd -P)"
root="${ARDIA_REPO:-$(git -C "$here" rev-parse --show-superproject-working-tree)}"
[ -f "$root/scripts/lib/instance.mjs" ] || { echo "error: needs an ardia checkout: set ARDIA_REPO, or run it from ardia's plugins submodule" >&2; exit 64; }
work="$(cd "$(mktemp -d /tmp/ac-token.XXXXXX)" && pwd -P)"
data="$work/d"
mkdir -p "$data"
pid=""
server=""
cleanup() {
  [ -n "$pid" ] && "$cli" --data-dir "$data" browse --session smoke close >/dev/null 2>&1 || true
  [ -n "$pid" ] && { kill "$pid" 2>/dev/null; for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; kill -KILL "$pid" 2>/dev/null; } || true
  [ -n "$server" ] && { kill "$server"; wait "$server"; } 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

status=0
check() {
  if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  ($3)}"; status=1; fi
}
field() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { let v = JSON.parse(s); for (const k of process.argv[1].split(".")) v = v?.[k]; console.log(v ?? ""); } catch { console.log(""); } })' "$1"
}

(cd "$root" && node -e "import('./scripts/lib/instance.mjs').then(({ session }) => { const fs = require('fs'); fs.writeFileSync(process.argv[1] + '/session.json', JSON.stringify(session({ settings: { cliControl: true } }))); fs.writeFileSync(process.argv[1] + '/onboarding.json', JSON.stringify({ version: 1, completedAt: 1 })); })" "$data")
node -e 'const [dir, out] = process.argv.slice(1); const path = require("path"); const fs = require("fs");
require("http").createServer((req, res) => {
  const file = path.join(dir, path.normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, body) => { res.writeHead(error ? 404 : 200, { "Content-Type": file.endsWith(".html") ? "text/html" : "application/octet-stream" }); res.end(error ? "" : body); });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(out, String(this.address().port)); });' "$here/ts/tests/fixtures/browse" "$work/port" >/dev/null 2>&1 &
server=$!
for _ in $(seq 1 50); do [ -s "$work/port" ] && break; sleep 0.1; done
port="$(cat "$work/port")"
open -g -n --env ARDIA_BACKGROUND=1 --env "ARDIA_DATA_DIR=$data" ${metro:+--env "ARDIA_INSTANCE=jsLocation=$metro"} \
  --stdout "$data/app.out.log" --stderr "$data/app.out.log" "$app"
control="$data/Chromium/ArdiaControl.json"
for _ in $(seq 1 300); do [ -s "$control" ] && break; sleep 0.2; done
[ -s "$control" ] || { echo "FAIL  the ardia command's token server starts  (no $control after 60 s)"; exit 1; }
pid="$(field pid <"$control")"
browse() { "$cli" --data-dir "$data" browse --session smoke "$@" 2>&1 || true; }
page="http://127.0.0.1:$port/login.html"

read="$(browse read "$page" --json)"
[ "$(field success <<<"$read")" = true ] && [ "$(field data.pages.0.title <<<"$read")" = "Fixture Login" ] && ok=1 || ok=0
check "ardia browse read <url> reads a page over the token connection" $ok "$(head -c 300 <<<"$read")"
opened="$(browse open "$page" --json)"
[ "$(field success <<<"$opened")" = true ] && ok=1 || ok=0
check "ardia browse open <url> opens a tab over the token connection" $ok "$(head -c 300 <<<"$opened")"
again="$(browse read --json)"
[ "$(field success <<<"$again")" = true ] && ok=1 || ok=0
check "ardia browse read reads the session's tab" $ok "$(head -c 300 <<<"$again")"
shot="$work/shot.png"
browse screenshot "$shot" >/dev/null
[ "$(head -c 4 "$shot" 2>/dev/null | tail -c 3)" = PNG ] && ok=1 || ok=0
check "ardia browse screenshot pictures the session's background tab" $ok
viewport="$(browse set viewport 390 844 --json)"
sized="$(browse eval "innerWidth + 'x' + innerHeight" --json)"
if [ "$(field success <<<"$viewport")" = true ]; then
  [ "$(field data.result <<<"$sized")" = 390x844 ] && ok=1 || ok=0
  check "ardia browse set viewport sizes a tab it took off-screen" $ok "$(head -c 300 <<<"$sized")"
  browse set viewport reset >/dev/null
else
  [ "$(field code <<<"$viewport")" = viewport_needs_hidden_tab ] && [ "$(field data.result <<<"$sized")" != 390x844 ] && ok=1 || ok=0
  check "ardia browse set viewport is refused on a tab Ardia has shown" $ok "$(head -c 300 <<<"$viewport")"
fi
cookies="$(browse cookies --json)"
if [ "$(field success <<<"$cookies")" = true ]; then
  check "ardia browse cookies reads cookies (Ardia 0.2.49 or later)" 1
else
  [ "$(field code <<<"$cookies")" = policy_refused ] && [ "$(field data.method <<<"$cookies")" = Network.getCookies ] && grep -q "needs Ardia 0.2.49 or later" <<<"$(field error <<<"$cookies")" && ok=1 || ok=0
  check "an older Ardia refuses cookies by name and says which Ardia allows it" $ok "$(head -c 300 <<<"$cookies")"
fi
exit $status
