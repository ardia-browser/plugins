# Command Line

The `ardia` command as an Ardia plugin: drive Ardia from your terminal or an agent.
Its manual is [docs/cli.md](docs/cli.md).

Ardia ships this plugin built in as one of its official plugins. Install it in one click from **Settings › Plugins**
(or the onboarding step that offers it); once installed it stays, with no switch to turn it off. Installing copies it
into `~/Library/Application Support/Ardia/Programs/cli/`, checks the copy against the digest the release signed, and
links `~/.local/bin/ardia` to it. An `ardia` installed the old way is adopted on update with no click: its link moves
to the new copy, and `~/Library/Application Support/Ardia/CLI/current` points at it, so paths saved through the old
home keep working. Installing turns on "Let the ardia command control Ardia", as the sheet says; after that the setting
is yours. The program runs as you, outside Ardia's sandbox, like anything you install.

It declares:

- `official` and `alwaysOn`, which only a plugin built into Ardia may declare, and the `terminal.fill` icon (`official` lists it among
  Ardia's official plugins; `alwaysOn` means once installed, it stays);
- `programs`: `ardia` (`bin/ardia`), with `afterUpdate` run once per new version, as `install.sh` did after an upgrade:
  `skills install --auto`, `skills refresh`, `computer refresh`;
- the `control` permission.

It has no helper, page or tools.

## Build

```sh
plugins/cli/build.sh <out dir>
```

This writes `<out dir>/cli`, the plugin folder Ardia bundles, packed as `cli-plugin-<version>-<platform>.tar.gz`,
plus the command's tarball `ardia-cli-<version>-<platform>.tar.gz` for Linux and hand installs, each with its
`.sha256`. `bin/ardia` is the TypeScript command as one Bun executable, with its Node-API addon `bin/ardia-libc.so`
beside it and esbuild in `libexec/`; there is no Python and no Rust in it. The version is `plugin.json`'s
(`ARDIA_PLUGIN_VERSION` overrides it for a local build). It needs Bun 1.3.14 and a C compiler; `scripts/build.sh --help`
lists the rest.

## Release

The command has its own version and releases, apart from Ardia's. Bump `version` in `plugin.json`, merge, and push
`cli-v<version>`: `.github/workflows/cli-release.yml` builds macOS and Linux with Bun, and publishes the release with
every artifact and its `.sha256` (pull requests run it as a dry run). Ardia then pins it with
`scripts/release/official-plugins.py pin cli <version>` in ardia-browser/ardia, and its next release bundles, signs
(Developer ID, hardened runtime) and notarizes it (`docs/cli.md` › Build and release).

## Test

```sh
cd plugins/cli
uv venv --python 3.13 /tmp/ardia-cli-venv
VIRTUAL_ENV=/tmp/ardia-cli-venv uv pip install --require-hashes --no-build -r requirements.lock
/tmp/ardia-cli-venv/bin/python -m unittest discover -s tests
(cd ts && bun install --frozen-lockfile --ignore-scripts && bun test ./tests)
```

A few checks compare against Ardia's own source, such as the ingest key, the tab group colours and the feedback
service. They run with `ARDIA_REPO` pointing at an ardia checkout, and skip otherwise.
`ardia_cli/schemas/plugin.schema.json` is ardia's published `docs/plugin.schema.json`; CI compares it with ardia main
and fails when they differ, so copy it over. `tests/fixtures/plugins` is a copy of ardia's `tests/fixtures/plugins`.

The command and Ardia talk over the control socket, whose protocol both sides check at `hello`
(`ardia_cli/control.py` `PROTOCOL`, `MIN_APP_PROTOCOL`; ardia's `automationMethods.ts` `PROTOCOL`,
`MIN_CLIENT_PROTOCOL`): raise your minimum when you need the other side's newer behaviour, and the mismatch says which
one to update.
