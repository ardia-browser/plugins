#!/bin/sh
# Builds the ardia CLI tarball: the TypeScript ardia as one Bun executable (bin/ardia), the Node-API addon it loads
# from beside itself (bin/ardia-libc.so), and esbuild (libexec/esbuild), the helper `ardia scripts` and userscripts
# bundle with. No Python, no Rust: axe-core and every other asset are embedded in bin/ardia.
#
#   plugins/cli/scripts/build.sh <version> <out dir> [--platform macos-arm64|linux-x64] [--from <folder>]
#   plugins/cli/scripts/build.sh -h | --help
#
# Writes <out dir>/ardia-cli-<version>-<platform>.tar.gz and its .sha256 (sha256sum format). --from packs the bin and
# libexec folders of a folder built before (plugins/cli/build.sh's signed plugin folder) instead of building them, with
# the same layout, after checking that its ardia says <version>. The platform defaults to
# the host's (macos-arm64 on Apple silicon, linux-x64 on Linux x86_64) and must be the host's: the build runs the
# program it made. Needs Bun 1.3.14 (on PATH or ~/.bun/bin/bun), a C compiler (xcrun clang on macOS, cc on Linux) and
# the network for esbuild from npm, which is pinned by sha256 and npm's sha512 integrity and cached in
# ~/Library/Caches/ardia-cli-build on macOS and ${XDG_CACHE_HOME:-~/.cache}/ardia-cli-build on Linux.
set -eu

bun_version=1.3.14
esbuild_version=0.28.2

case ${1:-} in
  -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
esac
usage() {
  sed -n '6,7p' "$0" | sed 's/^# *//' >&2
  exit 64
}
[ $# -ge 2 ] || usage
version=$1
out=$2
shift 2
platform=
from=
while [ $# -gt 0 ]; do
  case $1 in
    --platform) [ $# -ge 2 ] || usage; platform=$2; shift 2 ;;
    --platform=*) platform=${1#--platform=}; shift ;;
    --from) [ $# -ge 2 ] || usage; from=$2; shift 2 ;;
    *) usage ;;
  esac
done
printf '%s\n' "$version" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[a-z]{1,16}\.[0-9]{1,4})?$' \
  || { echo "build.sh: bad version: $version" >&2; exit 64; }

case $(uname -s)-$(uname -m) in
  Darwin-arm64) host=macos-arm64 ;;
  Linux-x86_64) host=linux-x64 ;;
  *) host=unsupported ;;
esac
platform=${platform:-$host}
case $platform in
  macos-arm64)
    bun_target=bun-darwin-arm64
    esbuild_platform=darwin-arm64
    esbuild_sha256=1980cde09749094452b20d36ff267585ccb3f72749c7bc97291cd9996ccf5a2a
    esbuild_sha512=n4KqkOQrraxHJcgjM1RvwbigfQKIKJVpM7xp+KsxiyUSrRdIXnt73VhrPAx0fV44hgfmIVKjxMN9J1t5jySVkw==
    ;;
  linux-x64)
    bun_target=
    esbuild_platform=linux-x64
    esbuild_sha256=9573bb2233aab0f9ea7647d5cca9726113cc1768de61d66b17267f4db84488f6
    esbuild_sha512=4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==
    ;;
  *) echo "build.sh: the platform is macos-arm64 or linux-x64, got $platform" >&2; exit 64 ;;
esac
[ "$platform" = "$host" ] || { echo "build.sh: build $platform on a $platform host (this one is $(uname -s) $(uname -m))" >&2; exit 64; }
esbuild_asset=esbuild-$esbuild_platform-$esbuild_version.tgz
esbuild_url=https://registry.npmjs.org/@esbuild/$esbuild_platform/-/$esbuild_platform-$esbuild_version.tgz

if [ "$platform" = linux-x64 ]; then
  case ${XDG_CACHE_HOME:-} in
    /*) cache=$XDG_CACHE_HOME/ardia-cli-build ;;
    *) cache=$HOME/.cache/ardia-cli-build ;;
  esac
  sha256() { sha256sum "$@"; }
  sha512_base64() { openssl dgst -sha512 -binary "$1" | base64 -w 0; }
else
  cache=$HOME/Library/Caches/ardia-cli-build
  sha256() { shasum -a 256 "$@"; }
  sha512_base64() { openssl dgst -sha512 -binary "$1" | base64; }
fi

cli_dir=$(cd "$(dirname "$0")/.." && pwd)

pack() {
  links=$(find "$root" -type l | head -n 5)
  [ -z "$links" ] || { echo "build.sh: the CLI has links, and Ardia refuses them: $links" >&2; exit 1; }
  tarball=ardia-cli-$version-$platform.tar.gz
  if [ "$platform" = linux-x64 ]; then
    tar --sort=name --owner=0 --group=0 --numeric-owner --no-xattrs --no-acls --no-selinux \
      -czf "$out/$tarball.part" -C "$work" "ardia-cli-$version"
  else
    COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --uid 0 --gid 0 --uname root --gname wheel \
      -czf "$out/$tarball.part" -C "$work" "ardia-cli-$version"
  fi
  mv "$out/$tarball.part" "$out/$tarball"
  (cd "$out" && sha256 "$tarball" >"$tarball.sha256")
  printf '%s\n' "$out/$tarball"
}

if [ -n "$from" ]; then
  from=$(cd "$from" && pwd)
  mkdir -p "$out"
  out=$(cd "$out" && pwd)
  work=$(mktemp -d "${TMPDIR:-/tmp}/ardia-cli-build.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  root=$work/ardia-cli-$version
  mkdir "$root"
  cp -pR "$from/bin" "$from/libexec" "$root/"
  mkdir "$root/.leases"
  [ "$("$root/bin/ardia" --version)" = "ardia $version" ] || { echo "build.sh: the ardia in $from doesn't say $version" >&2; exit 1; }
  [ "$("$root/libexec/esbuild" --version)" = "$esbuild_version" ] || { echo "build.sh: the esbuild in $from doesn't run" >&2; exit 1; }
  pack
  exit 0
fi

bun=$(command -v bun 2>/dev/null || true)
[ -n "$bun" ] || bun=$HOME/.bun/bin/bun
[ -x "$bun" ] || { echo "build.sh: the TypeScript ardia builds with Bun $bun_version, and there's no bun on PATH or at ~/.bun/bin/bun (CI: oven-sh/setup-bun with bun-version: $bun_version)" >&2; exit 1; }
found_bun=$("$bun" --version 2>/dev/null || echo unknown)
[ "$found_bun" = "$bun_version" ] || { echo "build.sh: the TypeScript ardia builds with Bun $bun_version, and $bun is $found_bun" >&2; exit 1; }

mkdir -p "$cache" "$out"
out=$(cd "$out" && pwd)
if ! [ -f "$cache/$esbuild_asset" ] || [ "$(sha256 "$cache/$esbuild_asset" | awk '{ print $1 }')" != "$esbuild_sha256" ]; then
  curl -fsSL --proto =https -o "$cache/$esbuild_asset.part" "$esbuild_url"
  mv "$cache/$esbuild_asset.part" "$cache/$esbuild_asset"
fi
actual=$(sha256 "$cache/$esbuild_asset" | awk '{ print $1 }')
[ "$actual" = "$esbuild_sha256" ] || { echo "build.sh: $esbuild_asset checksum mismatch ($actual)" >&2; exit 1; }
actual=$(sha512_base64 "$cache/$esbuild_asset")
[ "$actual" = "$esbuild_sha512" ] || { echo "build.sh: $esbuild_asset sha512 mismatch ($actual)" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/ardia-cli-build.XXXXXX")
trap 'rm -rf "$work"' EXIT
root=$work/ardia-cli-$version
mkdir -p "$root/bin" "$root/libexec"

PATH=$(dirname "$bun"):$PATH sh "$cli_dir/ts/scripts/build.sh" --version "$version" ${bun_target:+--target "$bun_target"} \
  --out "$root/bin/ardia" >/dev/null
chmod 755 "$root/bin/ardia"
chmod 644 "$root/bin/ardia-libc.so"

mkdir "$work/esbuild"
tar -xzf "$cache/$esbuild_asset" -C "$work/esbuild" package/bin/esbuild
cp "$work/esbuild/package/bin/esbuild" "$root/libexec/esbuild"
chmod 755 "$root/libexec/esbuild"
rm -rf "$work/esbuild"
[ "$("$root/libexec/esbuild" --version)" = "$esbuild_version" ] || { echo "build.sh: the bundled esbuild doesn't run" >&2; exit 1; }

probe=$work/probe.js
printf 'process.stdout.write("runtime-switch-open")\n' >"$probe"
for switch in "BUN_BE_BUN=1" "BUN_OPTIONS=--preload=$probe"; do
  export "${switch?}"
  ARDIA_CLI_HOME="$work/cli-home" ARDIA_TELEMETRY=off "$root/bin/ardia" "$probe" >"$work/smoke" 2>&1 </dev/null || true
  unset BUN_BE_BUN BUN_OPTIONS
  if grep -q runtime-switch-open "$work/smoke"; then
    echo "build.sh: bin/ardia still runs other code with $switch" >&2
    exit 1
  fi
done
rm "$probe"
ARDIA_DATA_DIR=$work/no-ardia
export ARDIA_DATA_DIR
smoke=0
ARDIA_CLI_HOME="$work/cli-home" ARDIA_TELEMETRY=off "$root/bin/ardia" tabs 2>"$work/smoke" >/dev/null || smoke=$?
[ "$smoke" = 2 ] && grep -q "Ardia isn't running" "$work/smoke" \
  || { echo "build.sh: bin/ardia tabs doesn't run by itself ($smoke: $(cat "$work/smoke"))" >&2; exit 1; }
ARDIA_BROWSE_FOR_PLUGIN=1
export ARDIA_BROWSE_FOR_PLUGIN
smoke=0
ARDIA_CLI_HOME="$work/cli-home" ARDIA_TELEMETRY=off "$root/bin/ardia" browse get title 2>"$work/smoke" >/dev/null || smoke=$?
unset ARDIA_BROWSE_FOR_PLUGIN ARDIA_DATA_DIR
[ "$smoke" = 77 ] && grep -q "needs ARDIA_PLUGIN_CREDENTIAL_FD, the descriptor" "$work/smoke" \
  || { echo "build.sh: bin/ardia browse doesn't run by itself ($smoke: $(cat "$work/smoke"))" >&2; exit 1; }
rm -rf "$work/cli-home" "$work/no-ardia" "$work/smoke"
mkdir "$root/.leases"
[ "$("$root/bin/ardia" --version)" = "ardia $version" ] || { echo "build.sh: the built ardia doesn't say $version" >&2; exit 1; }
[ ! -e "$root/python" ] || { echo "build.sh: the CLI has a python folder, and it ships no Python" >&2; exit 1; }
elsewhere=$(awk 'NF >= 2 && $NF != "ts" { print $0 }' "$cli_dir/ts/assets/served.txt" | head -n 3)
[ -z "$elsewhere" ] || { echo "build.sh: served.txt routes rows somewhere other than TypeScript: $elsewhere" >&2; exit 1; }
pack
