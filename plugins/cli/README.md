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

Its `plugin.json` is manifest 3, `@ardia/cli`, and declares:

- `scope: "global"` (one copy for the whole app, as `programs` and `control` require) and the `terminal.fill` icon;
- `main: "dist/index.js"`, built from `main/` with `@ardia/plugin-sdk` 3: the **Command Line: Show Status** view;
- `contributes.programs`: `ardia` (`bin/ardia`), with `afterUpdate` run once per new version, as `install.sh` did after
  an upgrade: `skills install --auto`, `skills refresh`, `computer refresh`;
- `permissions.control`, and the `telemetry` it discloses;
- `release`: `ardia-browser/plugins`, tags `cli-v<version>`, one archive per platform it builds on,
  `cli-<version>-macos-arm64.tar.gz` and `cli-<version>-linux-x64.tar.gz`.

It has no helper, page or tools.

## Build

```sh
plugins/cli/build.sh <out dir>
```

This writes `<out dir>/cli`, the plugin folder, packed as the registry asset `cli-<version>-<platform>.tar.gz` (with
`cli/` at its root, deterministic, by `scripts/pack-folder.mjs`, as `ardia-plugin pack` would if `bin/ardia` fit its
32 MB per-file limit), plus the command's tarball `ardia-cli-<version>-<platform>.tar.gz` for Linux and hand
installs, each with its `.sha256`. `main/` builds from the repository's pnpm workspace, so run `pnpm install` at the
root first. `bin/ardia` is the TypeScript command as one Bun executable, with its Node-API addon `bin/ardia-libc.so`
beside it and esbuild in `libexec/`; there is no Python and no Rust in it. The version is `plugin.json`'s
(`ARDIA_PLUGIN_VERSION` overrides it for a local build). It needs Bun 1.3.14 and a C compiler; `scripts/build.sh --help`
lists the rest.

## Release

The command has its own version and releases, apart from Ardia's. Bump `version` in `plugin.json`, merge, and push
`cli-v<version>`: `.github/workflows/release-plugin.yml` builds macOS and Linux with Bun (Developer ID-signing and
notarizing the macOS build when the `cli-release` environment has its secrets), co-signs each archive with the
official native key (`<asset>.official-sig`), and publishes the release with the two registry archives, their
`.sha256` and `install.sh` (pull requests that touch the release scripts run it as a dry run). Ardia then pins it with
`scripts/release/official-plugins.py pin cli <version>` in ardia-browser/ardia, and its next release bundles, signs
(Developer ID, hardened runtime) and notarizes it (`docs/cli.md` › Build and release).

## Test

```sh
cd plugins/cli/ts
bun install --frozen-lockfile --ignore-scripts
sh scripts/build.sh
bun run test
bun run test:parity
```

`bun run test` runs every file under `ts/tests` except `ts/tests/parity`, in parallel. `bun run test:parity` runs the
parity cases: each `ardia` call in `ts/tests/parity/cases` checked against its captured result (`docs/cli.md` › Test).
Both need the built `ts/dist/ardia-ts`. No test needs Python. `ts/assets/plugin.schema.json` is ardia's published
`docs/plugin.schema.json`; CI compares it with ardia main and fails when they differ, so copy it over.

The command and Ardia talk over the control socket, whose protocol both sides check at `hello`
(`ts/src/protocol.ts` `PROTOCOL`, `MIN_APP_PROTOCOL`; ardia's `automationMethods.ts` `PROTOCOL`,
`MIN_CLIENT_PROTOCOL`): raise your minimum when you need the other side's newer behaviour, and the mismatch says which
one to update.
