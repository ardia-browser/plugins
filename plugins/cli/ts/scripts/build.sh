#!/bin/sh
# Builds the TypeScript ardia as one Bun executable, straight from the sources (tsrs only checks them).
#
#   plugins/cli/ts/scripts/build.sh [--version <version>] [--target bun-darwin-arm64|bun-darwin-x64] [--out <file>]
#
# The version defaults to $ARDIA_CLI_VERSION, else 0.0.0.dev0; the target to the host's; the output to
# plugins/cli/ts/dist/ardia-ts. The program never reads .env or bunfig.toml from the folder it runs in.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
version=${ARDIA_CLI_VERSION:-0.0.0.dev0}
target=
out=$here/dist/ardia-ts
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    --version) version=$2; shift 2 ;;
    --target) target=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 64 ;;
  esac
done
printf '%s\n' "$version" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}((-[a-z]{1,16}\.[0-9]{1,4})|(\.dev0))?$' \
  || { echo "build.sh: bad version: $version" >&2; exit 64; }
case $target in
  ''|bun-darwin-arm64|bun-darwin-x64) ;;
  *) echo "build.sh: the target is bun-darwin-arm64 or bun-darwin-x64, got $target" >&2; exit 64 ;;
esac
bun=$(command -v bun 2>/dev/null || true)
[ -n "$bun" ] || bun=$HOME/.bun/bin/bun
[ -x "$bun" ] || { echo "build.sh: bun not found" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
cd "$here"
"$bun" build src/main.ts --compile --minify \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --no-compile-autoload-tsconfig --no-compile-autoload-package-json \
  --define "ARDIA_CLI_VERSION=\"$version\"" \
  ${target:+--target=$target} --outfile "$out" >/dev/null
echo "$out"
