#!/bin/sh
# Usage: plugins/protonpass/build.sh <out dir>
#   Builds the Proton Pass plugin folder into <out dir>/protonpass: plugin.json with its version set and dist/main.js
#   built from plugins/protonpass/main with npm. The version is $ARDIA_PLUGIN_VERSION, else plugin.json's. The plugin is
#   JavaScript only, so one arch-neutral artifact serves every Mac: <out dir>/protonpass-plugin-<version>.tar.gz and its
#   .sha256, packed as Ardia's release fetches it.
set -eu

case "${1:-}" in ''|-h|--help) sed -n '2,6s/^# \{0,1\}//p' "$0"; exit 0 ;; esac

here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
version=${ARDIA_PLUGIN_VERSION:-$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$here/plugin.json" | head -n 1)}
case $version in
  *[!0-9A-Za-z.-]*|'') echo "build.sh: $version isn't a version" >&2; exit 1 ;;
esac

(cd "$here/main" && npm ci --ignore-scripts --no-audit --no-fund --silent && npm run --silent build)

dest="$out/protonpass"
rm -rf "$dest"
mkdir -p "$dest/dist"
sed "s/^\( *\"version\": *\)\"[^\"]*\"/\1\"$version\"/" "$here/plugin.json" | grep -v '"\$schema"' >"$dest/plugin.json"
cp "$here/main/dist/main.js" "$dest/dist/main.js"
links=$(find "$dest" -type l | head -n 5)
[ -z "$links" ] || { echo "build.sh: Ardia refuses links in a plugin folder, and these are links: $links" >&2; exit 1; }

packed="protonpass-plugin-$version.tar.gz"
case $(uname -s) in
  Darwin) (cd "$out" && COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$packed" protonpass) ;;
  *) (cd "$out" && tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$packed" protonpass) ;;
esac
(cd "$out" && { command -v sha256sum >/dev/null && sha256sum "$packed" || shasum -a 256 "$packed"; } >"$packed.sha256")
echo "$dest"
