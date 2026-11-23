#!/usr/bin/env bash
# Usage: .github/release/check-build.sh <out dir> <version>
#   Checks what plugins/cli/build.sh <out dir> left for this host's platform: the ardia command says <version>, the
#   addon and esbuild are there, no Python, plugin.json carries <version>, every .sha256 matches and the plugin tarball
#   lists cleanly with no symbolic or hard links. Appends a size line to $GITHUB_STEP_SUMMARY when it is set.
set -euo pipefail

case "${1:-}" in ''|-h|--help) sed -n '2,5s/^# \{0,1\}//p' "$0"; exit 0 ;; esac
out=$1
version=$2
case $(uname -s) in Darwin) platform=macos-arm64 ;; *) platform=linux-x64 ;; esac

test "$("$out/cli/bin/ardia" --version)" = "ardia $version"
test -f "$out/cli/bin/ardia-libc.so"
test "$("$out/cli/libexec/esbuild" --version)" = 0.28.2
test ! -e "$out/cli/python"
grep -q "\"version\": \"$version\"" "$out/cli/plugin.json"
(cd "$out" && { command -v sha256sum >/dev/null && sha256sum -c ./*.sha256 || shasum -a 256 -c ./*.sha256; })
packed="$out/cli-plugin-$version-$platform.tar.gz"
listing=$(tar -tvzf "$packed")
links=$(grep -c '^[lh]' <<<"$listing" || true)
[ "$links" = 0 ] || { echo "::error::the plugin folder has $links links: Ardia refuses them"; exit 1; }
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "- $platform: $(du -sh "$out/cli" | cut -f1) folder, bin/ardia $(wc -c < "$out/cli/bin/ardia") bytes, plugin tarball $(wc -c < "$packed") bytes" >> "$GITHUB_STEP_SUMMARY"
fi
