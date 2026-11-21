# Ardia plugins

Small add-ons for [Ardia](https://ardia.dev). A plugin is a `plugin.json` whose settings go into your
`~/.config/ardia/config.json`, written by the `ardia` command. Ardia applies them at once, with no restart.

## Before you start

Install the `ardia` command: in Ardia, open **Settings**, search for **command line**, and install it.

## Plugins

| Plugin | What it does | Needs |
|---|---|---|
| [`cli`](plugins/cli) | The `ardia` command: drive Ardia, read pages and run its commands from your terminal or an agent. Built into Ardia: install it in one click from **Settings › Plugins**. | Ardia on macOS |
| [`apple-passwords`](plugins/apple-passwords) | Fill logins and verification codes from Apple's Passwords app on every site. Built into Ardia, off until you turn it on in **Settings › Plugins**. | Ardia 0.2.47-nightly.8 on macOS |
| [`compact-command-bar`](plugins/compact-command-bar/plugin.json) | ⌘T stops listing your pinned tabs and Top Apps, and shows at most 5 open tabs before you type. Typing still finds every tab. | Ardia 0.2.46-nightly.4 |
| [`ai`](plugins/ai/README.md) | A chat tab that reads and uses your tabs with your permission, on your own Claude plan. A full plugin: its own program, page and tools. | Ardia with the plugin host (ardia-browser/ardia#2462) |

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/mantrakp04/ardia-plugins/main/install.sh | sh -s -- compact-command-bar
```

Remove it:

```sh
curl -fsSL https://raw.githubusercontent.com/mantrakp04/ardia-plugins/main/install.sh | sh -s -- --remove compact-command-bar
```

List the plugins with `--list`.

## Make it yours

`compact-command-bar` writes this:

```json
"commandBarStart": { "openTabs": { "hidePinned": true, "hideTopApps": true, "limit": 5 } }
```

Change any part with the `ardia` command. To keep Top Apps and list 3 tabs:

```sh
ardia config set commandBarStart '{"openTabs": {"hidePinned": true, "limit": 3}}'
```

- `hidePinned`: leave out pinned tabs (the sidebar's pinned rows).
- `hideTopApps`: leave out Top Apps (the tiles).
- `limit`: how many open tabs to list, 0 to 20 (Ardia's default is 8). 0 shows an empty bar.

The list only shows when New Tab opens the command bar (Settings › General › New Tab Opens).

## Write a plugin

Add `plugins/<name>/plugin.json`, with `name` made of lowercase letters, digits and dashes:

```json
{
  "name": "my-plugin",
  "title": "My plugin",
  "description": "One line on what it changes.",
  "requires": "0.2.46-nightly.4",
  "settings": { "<setting>": "<value>" },
  "reset": { "<setting>": "<Ardia's default>" }
}
```

- `settings` are written with `ardia config set`, so only settings that `config.json` accepts work. `ardia config list` shows
  them all.
- `reset` is what `--remove` writes back.
- `requires` is the first Ardia version that knows the settings. The installer names it when an older Ardia refuses one.
- Add the name to `PLUGINS` in `install.sh` and a row to the table above.

Try a plugin from your checkout before you push it:

```sh
ARDIA_PLUGINS_SOURCE=. sh install.sh my-plugin
```

## Full plugins

Some plugins are more than settings: a program Ardia runs in its sandbox, a page that opens as a tab, tools and
commands (Ardia's `docs/plugins.md` is the contract). `install.sh` doesn't install those; each one's folder says how
it's built, and Ardia ships its own first-party plugins from this repo, which it mounts as a git submodule at
`plugins/`.

A full plugin's folder holds everything it needs to build and test on its own:

```
plugins/<name>/
  plugin.json     the manifest (checked against Ardia's published plugin schema)
  README.md       what it does, how it's built and tested, how to update what it builds on
  build.sh        builds the installable folder into <out dir>/<name>
  tests/          unit tests, run with node --test plugins/<name>/tests/*.test.mjs
```

CI: `Manifests` checks every `plugin.json` on every pull request against `schema/plugin.schema.json`, a copy of the
schema Ardia writes (ardia-browser/ardia `apps/cli/ardia_cli/schemas/plugin.schema.json`), refreshed here by a pull
request when Ardia's manifest grows; each full plugin has its own workflow that runs
only when its folder changes (`.github/workflows/<name>.yml`). To work on one from an Ardia checkout, change it here
in a pull request, then move Ardia's submodule pointer in a pull request there.

## License

Apache-2.0. `plugins/ai` builds T3 Code's server (MIT, copyright T3 Tools Inc.) from a pinned commit with the
patches in `plugins/ai/runtime/patches`; its notice is `plugins/ai/runtime/NOTICE`.
