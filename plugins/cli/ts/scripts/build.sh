#!/bin/sh
# Builds the TypeScript ardia as one Bun executable, straight from the sources (tsrs only checks them), and
# beside it ardia-libc.so, the Node-API addon (native/ardia-libc.c) it loads for the libc calls Bun lacks.
#
#   plugins/cli/ts/scripts/build.sh [--version <version>] [--target bun-darwin-arm64|bun-darwin-x64] [--out <file>]
#                                   [--node-headers <dir>]
#
# The version defaults to $ARDIA_CLI_VERSION, else 0.0.0.dev0; the target to the host's; the output to
# plugins/cli/ts/dist/ardia-ts, and the addon goes in the same folder, built for the target's architecture.
# --node-headers names an official Node include/node folder to check the addon's Node-API declarations against.
# The program never reads .env or bunfig.toml from the folder it runs in, and Bun's runtime switches (BUN_BE_BUN,
# BUN_OPTIONS, BUN_INSPECT and its variants) are renamed in the binary to names with "=", which no environment
# variable can have, so the signed program never runs code it wasn't built with.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
version=${ARDIA_CLI_VERSION:-0.0.0.dev0}
target=
out=$here/dist/ardia-ts
headers=
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    --version) version=$2; shift 2 ;;
    --target) target=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --node-headers) headers=$2; shift 2 ;;
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
addon=$(dirname "$out")/ardia-libc.so
warnings="-std=c11 -Wall -Wextra -Werror"
case $(uname -s) in
  Darwin)
    case $target in
      bun-darwin-x64) arch=x86_64 ;;
      bun-darwin-arm64) arch=arm64 ;;
      *) arch=$(uname -m) ;;
    esac
    compiler="xcrun clang"
    platform="-arch $arch -mmacosx-version-min=13.0"
    link="-bundle -undefined dynamic_lookup" ;;
  Linux)
    [ -z "$target" ] || { echo "build.sh: on Linux the target is the host's" >&2; exit 64; }
    compiler=cc
    platform="-D_GNU_SOURCE -pthread"
    link="-shared -fPIC -Wl,--build-id=none" ;;
  *) echo "build.sh: the addon builds on macOS and Linux" >&2; exit 64 ;;
esac
if [ -n "$headers" ]; then
  [ -f "$headers/node_api.h" ] || { echo "build.sh: no node_api.h in $headers" >&2; exit 64; }
  $compiler $warnings $platform -fsyntax-only -include "$headers/node_api.h" native/ardia-libc.c
fi
$compiler $warnings $platform -O2 $link -o "$addon" native/ardia-libc.c
"$bun" build src/main.ts --compile --minify \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --no-compile-autoload-tsconfig --no-compile-autoload-package-json \
  --define "ARDIA_CLI_VERSION=\"$version\"" \
  ${target:+--target=$target} --outfile "$out" >/dev/null
perl -0777 -pi -e 'for my $name (qw(BUN_BE_BUN BUN_OPTIONS BUN_INSPECT BUN_INSPECT_CONNECT_TO BUN_INSPECT_NOTIFY BUN_INSPECT_PRELOAD)) {
  (my $unmatchable = $name) =~ s/^BUN_/BUN=/;
  my $count = s/\x00\Q$name\E\x00/\x00$unmatchable\x00/g;
  die "build.sh: Bun reads $name in $count places, not 1: check the runtime-switch seal against this Bun\n" unless $count == 1;
}' "$out"
[ "$(uname -s)" != Darwin ] || codesign --force --sign - "$out" 2>/dev/null
echo "$out"
