#!/bin/sh
# Usage: plugins/ai/build.sh <out dir> [<t3code tree>]
#   Builds the AI plugin folder into <out dir>/ai: plugin.json, the skill, the runtime binary (T3 Code's server at
#   the pinned commit, patched by runtime/apply.sh) with its packages beside it, and the chat page (static files in page/).
#   Without a tree it clones T3 Code into ~/.cache/ardia-ai-runtime/t3code. Needs Node 26.13.1 and pnpm on PATH.
set -eu

case "${1:-}" in ''|-h|--help) sed -n '2,5s/^# \{0,1\}//p' "$0"; exit 0 ;; esac

here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
repo=$(sed -n 's/^repo=//p' "$here/runtime/UPSTREAM")
pin=$(sed -n 's/^commit=//p' "$here/runtime/UPSTREAM")
version=$(sed -n 's/^version=//p' "$here/runtime/UPSTREAM")
tree=${2:-$HOME/.cache/ardia-ai-runtime/t3code}

case "$(node --version)" in v26.*) ;; *) echo "build.sh: needs Node 26 (T3 Code's engines), found $(node --version)" >&2; exit 1 ;; esac

if [ ! -d "$tree/.git" ]; then
  git clone --filter=blob:none "$repo" "$tree"
fi
tree=$(cd "$tree" && pwd)
if ! git -C "$tree" cat-file -e "$pin^{commit}" 2>/dev/null; then git -C "$tree" fetch origin "$pin"; fi
if [ -z "${2:-}" ]; then git -C "$tree" -c advice.detachedHead=false checkout -q "$pin"; fi

"$here/runtime/apply.sh" "$tree"
(cd "$tree" && pnpm install --frozen-lockfile --prefer-offline >/dev/null)
(cd "$tree" && PATH="$tree/node_modules/.bin:$PATH" APP_VERSION="$version" node apps/server/scripts/cli.ts build-exe >/dev/null)

dest="$out/ai"
rm -rf "$dest"
mkdir -p "$dest/bin/node_modules/@ff-labs" "$dest/bin/node_modules/@yuuang" "$dest/skill"
cp "$here/plugin.json" "$dest/"
cp "$here/skill/browser.md" "$dest/skill/"
cp "$here/runtime/NOTICE" "$dest/NOTICE"
cp "$tree/apps/server/dist-exe/t3" "$dest/bin/ardia-ai"
pnpm_dir="$tree/node_modules/.pnpm"
cp -RL "$tree/apps/server/node_modules/undici" "$dest/bin/node_modules/undici"
cp -RL "$tree/apps/server/node_modules/ffi-rs" "$dest/bin/node_modules/ffi-rs"
cp -RL "$tree/apps/server/node_modules/@ff-labs/fff-node" "$dest/bin/node_modules/@ff-labs/fff-node"
cp -RL "$pnpm_dir"/@ff-labs+fff-bin-darwin-arm64@*/node_modules/@ff-labs/fff-bin-darwin-arm64 "$dest/bin/node_modules/@ff-labs/"
cp -RL "$pnpm_dir"/@yuuang+ffi-rs-darwin-arm64@*/node_modules/@yuuang/ffi-rs-darwin-arm64 "$dest/bin/node_modules/@yuuang/"
[ -d "$here/node_modules/esbuild" ] || (cd "$here" && npm ci --no-audit --no-fund >/dev/null)
node "$here/page/build.mjs" "$tree" "$dest/page" >/dev/null
echo "built $dest ($(du -sh "$dest" | cut -f1))"
