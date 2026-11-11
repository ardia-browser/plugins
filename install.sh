#!/bin/sh
set -eu

REPO_RAW="https://raw.githubusercontent.com/mantrakp04/ardia-plugins/main"
SOURCE="${ARDIA_PLUGINS_SOURCE:-$REPO_RAW}"
PLUGINS="compact-command-bar"

say() { printf '%s\n' "$*"; }
fail() { printf 'ardia-plugins: %s\n' "$*" >&2; exit 1; }

usage() {
  say "Installs an Ardia plugin: writes its settings into ~/.config/ardia/config.json with the"
  say "ardia command, and a running Ardia applies them at once."
  say ""
  say "usage: install.sh <plugin>            install a plugin"
  say "       install.sh --remove <plugin>   put back what the plugin changed"
  say "       install.sh --list              list the plugins"
  say ""
  say "ARDIA_PLUGINS_SOURCE=<folder> installs from a local checkout instead of GitHub."
}

find_ardia() {
  if command -v ardia >/dev/null 2>&1; then command -v ardia; return; fi
  for candidate in "$HOME/.local/bin/ardia" "/usr/local/bin/ardia" "/opt/homebrew/bin/ardia"; do
    if [ -x "$candidate" ]; then say "$candidate"; return; fi
  done
  fail "the ardia command isn't installed. In Ardia, open Settings, search for \"command line\", and install it."
}

fetch_plugin() {
  case "$1" in
    ''|*[!a-z0-9-]*) fail "\"$1\" isn't a plugin name (try --list)" ;;
  esac
  case "$SOURCE" in
    http://*|https://*)
      curl -fsSL "$SOURCE/plugins/$1/plugin.json" -o "$2" 2>/dev/null || fail "no plugin named \"$1\" (try --list)" ;;
    *)
      [ -f "$SOURCE/plugins/$1/plugin.json" ] || fail "no plugin named \"$1\" in $SOURCE"
      cp "$SOURCE/plugins/$1/plugin.json" "$2" ;;
  esac
}

plugin_entries() {
  osascript -l JavaScript - "$1" "$2" <<'JS'
function run(argv) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  if (text.isNil()) throw new Error("can't read the plugin file");
  const plugin = JSON.parse(text.js);
  const section = plugin[argv[1]];
  if (argv[1] === "title") return plugin.title || plugin.name;
  if (argv[1] === "requires") return plugin.requires || "";
  if (!section || typeof section !== "object" || Array.isArray(section)) return "";
  return Object.keys(section).map((key) => key + "\t" + JSON.stringify(section[key])).join("\n");
}
JS
}

apply_section() {
  ardia_bin="$1"; file="$2"; section="$3"; requires="$4"
  entries=$(plugin_entries "$file" "$section") || fail "the plugin file doesn't parse"
  [ -n "$entries" ] || fail "the plugin has no $section"
  printf '%s\n' "$entries" | while IFS="$(printf '\t')" read -r key value; do
    if ! output=$("$ardia_bin" config set "$key" "$value" 2>&1); then
      printf '%s\n' "$output" >&2
      if [ -n "$requires" ]; then
        fail "this Ardia doesn't know \"$key\" yet. Update Ardia to $requires or later (Settings › General › Check for Updates; the nightly channel gets it first), then run this again."
      fi
      fail "couldn't set $key"
    fi
    say "  set $key"
  done
}

[ $# -gt 0 ] || { usage; exit 1; }
mode=install
case "$1" in
  -h|--help) usage; exit 0 ;;
  --list)
    for name in $PLUGINS; do say "$name"; done
    exit 0 ;;
  --remove) mode=remove; shift; [ $# -gt 0 ] || { usage; exit 1; } ;;
esac
name="$1"

ardia_bin=$(find_ardia)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch_plugin "$name" "$tmp/plugin.json"
title=$(plugin_entries "$tmp/plugin.json" title)
requires=$(plugin_entries "$tmp/plugin.json" requires)

if [ "$mode" = install ]; then
  say "Installing $title"
  apply_section "$ardia_bin" "$tmp/plugin.json" settings "$requires"
  say "Done. Ardia picks it up at once; to remove it: install.sh --remove $name"
else
  say "Removing $title"
  apply_section "$ardia_bin" "$tmp/plugin.json" reset "$requires"
  say "Done."
fi
