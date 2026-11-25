#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: plugins/cli/build.sh <out dir>
  Builds the Command Line plugin folder into <out dir>/cli: the ardia command as scripts/build.sh packs it (bin/ardia,
  the Bun executable, with bin/ardia-libc.so beside it and libexec/esbuild), plugin.json (manifest 3) with its version
  set and no $schema, and dist/index.js built from plugins/cli/main. The version is $ARDIA_PLUGIN_VERSION, else
  plugin.json's. Ardia refuses links in a plugin's programs and makes .leases itself, so the folder has neither.
  Leaves in <out dir> the command's own tarball (ardia-cli-<version>-<platform>.tar.gz, for install.sh with
  ARDIA_CLI_URL) and the registry asset that plugin.json's release.assets names (cli-<version>-<platform>.tar.gz),
  packed deterministically by scripts/pack-folder.mjs with cli/ at its root, each with its .sha256.
  ARDIA_SIGN_CMD, when set, signs the folder before anything is packed: once the folder is complete (plugin.json,
  dist/index.js, no links) it runs as sh -c "$ARDIA_SIGN_CMD" ardia-sign <out dir>/cli, with the folder as $1, and
  should sign bin/ardia, bin/ardia-libc.so and libexec/esbuild in place. The build fails if it exits non-zero; after
  it, the signed ardia must still say the version, and both tarballs and their .sha256 files are packed from the
  signed folder, with the same layout as without it.
  plugins/cli/main builds with the root pnpm workspace's packages: run pnpm install at the repository root first.
USAGE
}

case "${1:-}" in '' | -h | --help) usage; [ -n "${1:-}" ] && exit 0 || exit 64 ;; esac

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
version=${ARDIA_PLUGIN_VERSION:-$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$here/plugin.json")}

build_main() {
  dest=$1
  [ -d "$here/main/node_modules/@ardia/plugin-sdk" ] || { echo "build.sh: plugins/cli/main has no @ardia/plugin-sdk; run pnpm install at the repository root" >&2; exit 1; }
  (cd "$here/main" && node build.mjs)
  mkdir -p "$dest/dist"
  cp "$here/main/dist/index.js" "$dest/dist/index.js"
}

write_manifest() {
  node -e '
    const fs = require("fs");
    const [from, to, version] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(from, "utf8"));
    delete manifest.$schema;
    manifest.version = version;
    fs.writeFileSync(to, JSON.stringify(manifest, null, 2) + "\n");
  ' "$here/plugin.json" "$1" "$version"
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
write_manifest "$dest/plugin.json"
build_main "$dest"
asset="cli-$version-$platform.tar.gz"
rm -f "$out/$asset" "$out/$asset.sha256"
if [ -n "${ARDIA_SIGN_CMD:-}" ]; then
  rm -f "$tarball" "$tarball.sha256"
fi
links=$(find "$dest" -type l | head -n 5)
[ -z "$links" ] || { echo "build.sh: Ardia copies a plugin's programs without links, and these are links: $links" >&2; exit 1; }
if [ -n "${ARDIA_SIGN_CMD:-}" ]; then
  sh -c "$ARDIA_SIGN_CMD" ardia-sign "$dest" || { echo "build.sh: ARDIA_SIGN_CMD failed on $dest" >&2; exit 1; }
  links=$(find "$dest" -type l | head -n 5)
  [ -z "$links" ] || { echo "build.sh: after ARDIA_SIGN_CMD, the plugin folder has links, which Ardia refuses: $links" >&2; exit 1; }
fi
[ "$("$dest/bin/ardia" --version)" = "ardia $version" ] || { echo "build.sh: the built ardia doesn't say $version" >&2; exit 1; }
[ -z "${ARDIA_SIGN_CMD:-}" ] || "$here/scripts/build.sh" "$version" "$out" --from "$dest" >/dev/null
node "$repo/scripts/pack-folder.mjs" "$dest" "$out/$asset" --root cli >/dev/null
echo "$dest"
