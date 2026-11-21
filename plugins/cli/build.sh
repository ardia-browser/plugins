#!/bin/sh
# Usage: plugins/cli/build.sh <out dir>
#   Builds the Command Line plugin folder into <out dir>/cli: the ardia command as scripts/build.sh packs it (bin/ardia,
#   the Bun executable, with bin/ardia-libc.so beside it and libexec/esbuild), plugin.json with its version set and,
#   once plugins/cli/main exists, dist/main.js built from it with npm. The version is $ARDIA_PLUGIN_VERSION, else
#   plugin.json's. Ardia refuses links in a plugin's programs and makes .leases itself, so the folder has neither. Also
#   leaves in <out dir> the command's tarball (ardia-cli-<version>-<platform>.tar.gz) and the folder packed as Ardia's
#   release fetches it (cli-plugin-<version>-<platform>.tar.gz), each with its .sha256.
set -eu

case "${1:-}" in ''|-h|--help) sed -n '2,8s/^# \{0,1\}//p' "$0"; exit 0 ;; esac

here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
version=${ARDIA_PLUGIN_VERSION:-$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$here/plugin.json" | head -n 1)}

build_manifest_v2_main() {
  dest=$1
  [ -d "$here/main" ] || return 0
  (cd "$here/main" && npm ci --no-audit --no-fund --silent && npm run --silent build)
  mkdir -p "$dest/dist"
  cp "$here/main/dist/main.js" "$dest/dist/main.js"
}

"$here/scripts/build.sh" "$version" "$out"
case $(uname -s) in Darwin) platform=macos-arm64 ;; *) platform=linux-x64 ;; esac
tarball="$out/ardia-cli-$version-$platform.tar.gz"

work=$(mktemp -d "${TMPDIR:-/tmp}/ardia-cli-plugin.XXXXXX")
trap 'rm -rf "$work"' EXIT
tar -xzf "$tarball" -C "$work"
dest="$out/cli"
rm -rf "$dest"
mv "$work/ardia-cli-$version" "$dest"
rmdir "$dest/.leases"
sed "s/^\( *\"version\": *\)\"[^\"]*\"/\1\"$version\"/" "$here/plugin.json" | grep -v '"\$schema"' >"$dest/plugin.json"
build_manifest_v2_main "$dest"
links=$(find "$dest" -type l | head -n 5)
[ -z "$links" ] || { echo "build.sh: Ardia copies a plugin's programs without links, and these are links: $links" >&2; exit 1; }
[ "$("$dest/bin/ardia" --version)" = "ardia $version" ] || { echo "build.sh: the built ardia doesn't say $version" >&2; exit 1; }
packed="cli-plugin-$version-$platform.tar.gz"
case $(uname -s) in
  Darwin) (cd "$out" && COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$packed" cli) ;;
  *) (cd "$out" && tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$packed" cli) ;;
esac
(cd "$out" && { command -v sha256sum >/dev/null && sha256sum "$packed" || shasum -a 256 "$packed"; } >"$packed.sha256")
echo "$dest"
