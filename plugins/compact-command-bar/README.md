# Compact Command Bar

`@ardia/compact-command-bar`: ⌘T stops listing your pinned tabs and Top Apps, and shows at most 5 open tabs before
you type. Typing still finds every tab. Install it from **Settings › Plugins**.

The plugin is only a manifest. It sets one Ardia setting while it's on, as `contributes.settings.defaults`:

```json
"commandBarStart": { "openTabs": { "hidePinned": true, "hideTopApps": true, "limit": 5 } }
```

Change any part with the `ardia` command, for example to keep Top Apps and list 3 tabs:

```sh
ardia config set commandBarStart '{"openTabs": {"hidePinned": true, "limit": 3}}'
```

- `hidePinned`: leave out pinned tabs (the sidebar's pinned rows).
- `hideTopApps`: leave out Top Apps (the tiles).
- `limit`: how many open tabs to list, 0 to 20 (Ardia's default is 8). 0 shows an empty bar.

The list only shows when New Tab opens the command bar (Settings › General › New Tab Opens).
