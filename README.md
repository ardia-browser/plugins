# Ardia plugins

Small add-ons for [Ardia](https://ardia.dev). A plugin is a `plugin.json` whose settings go into your
`~/.config/ardia/config.json`, written by the `ardia` command. Ardia applies them at once, with no restart.

## Before you start

Install the `ardia` command: in Ardia, open **Settings**, search for **command line**, and install it.

## Plugins

| Plugin | What it does | Needs |
|---|---|---|
| [`compact-command-bar`](plugins/compact-command-bar/plugin.json) | ⌘T stops listing your pinned tabs and Top Apps, and shows at most 5 open tabs before you type. Typing still finds every tab. | Ardia 0.2.46-nightly.4 |

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

## License

Apache-2.0
