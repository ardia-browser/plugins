#!/bin/sh
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Links a plugin from this checkout into Ardia for development, with @ardia/plugin-cli's ardia-plugin dev --once:
it builds the plugin, checks it, writes Ardia's plugins-dev/<scope>__<name>.json link to its folder and asks a
running Ardia to reload it. Ardia installs released plugins from its registry (ardia.dev/r/); this is for trying
your changes.

usage: sh install.sh <plugin> [--data-dir <dir>] [--config-dir <dir>]   build and link plugins/<plugin>
       sh install.sh --remove <plugin> [--data-dir <dir>] [--config-dir <dir>]   remove its dev link
       sh install.sh --list                                                 list the plugins

Run pnpm install at the repository root first. ARDIA_DATA_DIR works as --data-dir. Ardia reloads a linked plugin
on save only with Settings › Advanced › Let programs control Ardia on; otherwise it picks the link up when it starts.
cli is native and doesn't link this way: build it with plugins/cli/build.sh, and install the ardia command with
plugins/cli/install.sh.
USAGE
}

repo=$(cd "$(dirname "$0")" && pwd)
ardia_plugin=$repo/node_modules/.bin/ardia-plugin

manifest_field() {
  node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), m); process.stdout.write(v == null ? "" : String(v));' "$1" "$2"
}

plugin_dir() {
  case "$1" in
    ''|*[!a-z0-9-]*) fail "\"$1\" isn't a plugin name (try --list)" ;;
  esac
  [ -f "$repo/plugins/$1/plugin.json" ] || fail "there's no plugins/$1/plugin.json (try --list)"
  printf '%s\n' "$repo/plugins/$1"
}

config_dir() {
  if [ -n "$config_dir" ]; then printf '%s\n' "$config_dir"; return; fi
  if [ -n "$data_dir" ]; then printf '%s\n' "$data_dir/config"; return; fi
  case ${XDG_CONFIG_HOME:-} in
    /*) printf '%s\n' "$XDG_CONFIG_HOME/ardia" ;;
    *) printf '%s\n' "$HOME/.config/ardia" ;;
  esac
}

[ $# -gt 0 ] || { usage >&2; exit 64; }
mode=link
name=
data_dir=${ARDIA_DATA_DIR:-}
config_dir=
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    --list) mode=list; shift ;;
    --remove) mode=remove; shift ;;
    --data-dir) [ $# -ge 2 ] || fail "--data-dir needs a folder"; data_dir=$2; shift 2 ;;
    --config-dir) [ $# -ge 2 ] || fail "--config-dir needs a folder"; config_dir=$2; shift 2 ;;
    -*) fail "there's no option $1" ;;
    *) [ -z "$name" ] || fail "name one plugin, not $name and $1"; name=$1; shift ;;
  esac
done
command -v node >/dev/null 2>&1 || fail "this needs Node.js 24 or later"

if [ "$mode" = list ]; then
  for manifest in "$repo"/plugins/*/plugin.json; do
    dir=$(dirname "$manifest")
    printf '%-22s %-30s %s\n' "$(basename "$dir")" "$(manifest_field "$manifest" id)" "$(manifest_field "$manifest" version)"
  done
  exit 0
fi

[ -n "$name" ] || { usage >&2; exit 64; }
dir=$(plugin_dir "$name")
id=$(manifest_field "$dir/plugin.json" id)
[ -n "$id" ] || fail "plugins/$name/plugin.json has no id; is it manifest 3?"

if [ "$mode" = remove ]; then
  scope=${id%%/*}
  link="$(config_dir)/plugins-dev/${scope#@}__${id#*/}.json"
  if [ -f "$link" ]; then
    rm -f "$link"
    say "Removed $link; Ardia drops $id when it next looks."
  else
    say "$id isn't linked ($link isn't there)."
  fi
  exit 0
fi

[ "$name" != cli ] || fail "cli is native: build it with plugins/cli/build.sh <out dir>, and install the ardia command with plugins/cli/install.sh"
[ -x "$ardia_plugin" ] || fail "there's no node_modules/.bin/ardia-plugin: run pnpm install at $repo first"
if [ -f "$dir/package.json" ]; then
  say "Building $id"
  node "$repo/scripts/plugins.mjs" build "$name"
fi
set -- dev "$dir" --once
[ -z "$data_dir" ] || set -- "$@" --data-dir "$data_dir"
[ -z "$config_dir" ] || set -- "$@" --config-dir "$config_dir"
"$ardia_plugin" "$@"
say "Linked $id. To unlink it: sh install.sh --remove $name"
