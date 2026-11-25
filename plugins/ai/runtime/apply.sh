#!/bin/sh
# Usage: apply.sh <t3code tree>
#   Copies the AI plugin's runtime code into a T3 Code checkout at the pinned commit and applies the patch series.
#   Run it again after editing runtime/src: the copy is replaced, and patches already applied are left alone.
set -eu

case "${1:-}" in -h|--help) sed -n '2,4s/^# \{0,1\}//p' "$0"; exit 0 ;; esac

here=$(cd "$(dirname "$0")" && pwd)
tree=${1:?usage: apply.sh <t3code tree>}
tree=$(cd "$tree" && pwd)
pin=$(sed -n 's/^commit=//p' "$here/UPSTREAM")

if ! git -C "$tree" merge-base --is-ancestor "$pin" HEAD 2>/dev/null; then
  echo "apply.sh: $tree doesn't contain the pinned commit $pin" >&2
  exit 1
fi

marker="$tree/.ardia-patches"
want=$(cd "$here" && cat series $(grep -v '^#' series | sed 's|^|patches/|') | shasum -a 256 | cut -c1-64)
if [ -f "$marker" ] && [ "$(cat "$marker")" = "$want" ]; then
  echo "patches already applied"
elif [ -f "$marker" ] || ! git -C "$tree" diff --quiet HEAD -- apps packages; then
  echo "apply.sh: $tree has other changes; start from a clean checkout of $pin" >&2
  exit 1
else
  while read -r patch; do
    case "$patch" in ''|\#*) continue ;; esac
    git -C "$tree" apply --whitespace=nowarn "$here/patches/$patch"
    echo "applied $patch"
  done < "$here/series"
  echo "$want" > "$marker"
fi

dest="$tree/apps/server/src/ardia"
rm -rf "$dest"
mkdir -p "$dest"
cp "$here"/src/*.ts "$dest/"
echo "copied runtime/src to apps/server/src/ardia"
