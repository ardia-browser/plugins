#!/bin/sh
# Usage: plugins/bitwarden/build.sh <out dir>
#   Builds the Bitwarden plugin folder into <out dir>/bitwarden: plugin.json with its version set and dist/main.js
#   built from main/ with npm. The version is $ARDIA_PLUGIN_VERSION, else plugin.json's. The plugin is JavaScript only,
#   so one folder serves every Mac; it is packed as bitwarden-plugin-<version>.tar.gz, with its .sha256, the way
#   Ardia's Install fetches official plugins.
set -eu

case "${1:-}" in ''|-h|--help) sed -n '2,6s/^# \{0,1\}//p' "$0"; exit 0 ;; esac

here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
version=${ARDIA_PLUGIN_VERSION:-$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$here/plugin.json" | head -n 1)}
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "build.sh: \"$version\" isn't a version" >&2; exit 1 ;;
esac

(cd "$here/main" && npm ci --ignore-scripts --no-audit --no-fund --silent && npm run --silent build)

dest="$out/bitwarden"
rm -rf "$dest"
mkdir -p "$dest/dist"
sed "s/^\( *\"version\": *\)\"[^\"]*\"/\1\"$version\"/" "$here/plugin.json" | grep -v '"\$schema"' >"$dest/plugin.json"
cp "$here/main/dist/main.js" "$dest/dist/main.js"

links=$(find "$dest" -type l | head -n 5)
[ -z "$links" ] || { echo "build.sh: Ardia copies a plugin folder without links, and these are links: $links" >&2; exit 1; }

packed="bitwarden-plugin-$version.tar.gz"
case $(uname -s) in
  Darwin) (cd "$out" && COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$packed" bitwarden) ;;
  *) (cd "$out" && tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$packed" bitwarden) ;;
esac
(cd "$out" && { command -v sha256sum >/dev/null && sha256sum "$packed" || shasum -a 256 "$packed"; } >"$packed.sha256")
echo "$dest"
