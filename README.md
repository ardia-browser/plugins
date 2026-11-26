# Ardia plugins

The official `@ardia/*` plugins for [Ardia](https://ardia.dev), in one monorepo. Every plugin is a manifest 3
`plugin.json` built on [`@ardia/plugin-sdk`](https://www.npmjs.com/package/@ardia/plugin-sdk) 3, checked and packed
with [`@ardia/plugin-cli`](https://www.npmjs.com/package/@ardia/plugin-cli), and released from this repository by one
workflow. Ardia installs them from its registry at [ardia.dev/r/](https://ardia.dev/r/): open **Settings › Plugins**.

## Plugins

| Folder | Id | What it does | Kind |
|---|---|---|---|
| [`cli`](plugins/cli) | `@ardia/cli` | The `ardia` command: drive Ardia, read pages and run its commands from your terminal or an agent. | native (programs, `control`), global; macOS arm64 and Linux x64 |
| [`ai`](plugins/ai) | `@ardia/ai` | Ask Claude about the page you're on from the command bar (Tab switches into Ask), and answer other plugins through `ai.provider`, with your own Anthropic API key. | JS, provides `ai.provider` |
| [`developer-mode`](plugins/developer-mode) | `@ardia/developer-mode` | Arc's striped developer bar, with the console, Network and Inspect a click away, on the sites you're building. | manifest only (`siteSwitches`, `pageBar`) |
| [`compact-command-bar`](plugins/compact-command-bar) | `@ardia/compact-command-bar` | ⌘T stops listing your pinned tabs and Top Apps, and shows at most 5 open tabs before you type. | manifest only (`settings.defaults`), global |
| [`1password`](plugins/1password) | `@ardia/1password` | Fills and saves logins and codes from 1Password, approved in the 1Password app. | sidecar around `op`, provides `credentials.provider` |
| [`bitwarden`](plugins/bitwarden) | `@ardia/bitwarden` | Fills and saves logins, codes and passkeys from your Bitwarden vault. | sidecar around `bw`, provides `credentials.provider` |
| [`proton-pass`](plugins/proton-pass) | `@ardia/proton-pass` | Fills and saves logins and codes from Proton Pass. | sidecar around `pass-cli`, provides `credentials.provider` |

## Layout

```
plugins/<name>/                 one plugin: plugin.json, package.json, src/, test/, README.md
  plugin.json                   manifest 3; main is dist/index.js, built from src/index.ts(x)
  src/plugin.ts(x)              createPlugin(ardia): the plugin's definition, so tests run it on a mock host
plugins/cli/                    the ardia command (ts/, Bun), its Manifest 3 main (main/) and build.sh
packages/testing/               @ardia-plugins/testing: bundles a plugin's src for createMockHost() tests
packages/credential-provider/   @ardia-plugins/credential-provider: what the password managers share
scripts/                        plugins.mjs, release-info.mjs, official-sig.mjs, notify-registry.mjs, ardia-packages.mjs
.github/workflows/ci.yml        checks, builds, tests and packs the plugins a change touches
.github/workflows/release-plugin.yml   releases one plugin from its <name>-v<version> tag
```

Nothing vendors the SDK: every package depends on `@ardia/plugin-sdk` `^3.0.0` and `@ardia/plugin-cli` `^3.0.0`.

## Set up

Node 24 and pnpm (the version in `package.json`'s `packageManager`):

```sh
pnpm install
```

Until `@ardia/plugin-sdk` and `@ardia/plugin-cli` 3.0.0 are on npm, point the workspace at their tarballs first:

```sh
node scripts/ardia-packages.mjs /path/to/dir-with-ardia-plugin-sdk-and-cli-tgz
pnpm install
```

That normalizes them into `.ardia-packages/` (each tarball's `publishConfig` applied, `workspace:*` resolved), and
`.pnpmfile.cjs` resolves both packages from there; `node scripts/ardia-packages.mjs --clear` goes back to npm.
`pnpm-lock.yaml` is ignored until 3.0.0 is published, since a lock made against local tarballs names their paths.
CI takes the same tarballs from a GitHub release named by the `ardia_packages` input or the `ARDIA_PACKAGES_RELEASE`
variable (`owner/repo@tag`).

## Work on a plugin

`@ardia/plugin-cli`'s `ardia-plugin` does the work; each plugin's `package.json` scripts call it.

```sh
cd plugins/ai
pnpm exec ardia-plugin check     # plugin.json, the files it names, the pack's limits
pnpm exec ardia-plugin build     # esbuild: src/index.ts(x) → dist/index.js (IIFE, ES2022, JSX from the SDK)
pnpm exec ardia-plugin pack      # a deterministic release/<asset>.tar.gz and its .sha256
pnpm exec ardia-plugin dev       # rebuild on save, link into Ardia's plugins-dev/, reload, tail the log
pnpm test                        # node --test with createMockHost() from @ardia/plugin-sdk/testing
```

`ardia-plugin release` publishes a GitHub Release with `gh` from your machine; here, the release workflow does it.

Across the repository, `node scripts/plugins.mjs <check|build|typecheck|test|pack> [plugin…]` runs the same for
every plugin (or the ones named), and `node scripts/plugins.mjs list --changed origin/main` prints what a branch
touches. `sh install.sh <plugin>` builds a plugin and links it into your Ardia with `ardia-plugin dev --once`;
`sh install.sh --remove <plugin>` unlinks it and `sh install.sh --list` lists them.

## Release

Bump `version` in `plugins/<name>/plugin.json` (and its `package.json`), merge, and push the tag
`<name>-v<version>` (`release.tagPrefix`), like `ai-v1.0.0` or `cli-v0.8.0`. `release-plugin.yml`:

1. finds the plugin from the tag (`scripts/release-info.mjs`) and refuses a tag that isn't `plugin.json`'s version;
2. checks, builds, type-checks and tests it, and packs exactly the archives `release.asset` or `release.assets` names
   (`{name}-{version}.tar.gz`, or one per platform), each with its `.sha256`; `cli` builds on macOS and Linux with
   `plugins/cli/build.sh`, Developer ID-signed and notarized on macOS when the `cli-release` environment has its
   secrets;
3. co-signs a native plugin's archives (a sidecar, `programs` or `control`) in the publish-only job, the one job that
   sees `ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY`: it runs only for a real publish from the tag, checks out just
   `scripts/official-sig.mjs`, `scripts/lib.mjs`, `scripts/notify-registry.mjs` and the `plugin.json` files from that
   tag, and installs no packages (the script uses `node:crypto`, `node:fs` and `node:path` only).
   `<asset>.official-sig` is the bare unpadded base64url Ed25519 signature over
   `"ardia-official-native-v1\n" + canonicalJson({ v: 1, id, version, platform, sha256 })`, byte for byte
   `@ardia/plugin-sdk/registry`'s `officialArtifactMessage`, the registry's `officialSig`. It is verified against the
   repository variable `ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY`, never the signing key. Without the key, a native
   release stops; dry runs rehearse the signature with a throwaway key;
4. creates the GitHub Release, a prerelease when the version has a `-`, and, when `ARDIA_REGISTRY_WEBHOOK_URL` and
   `ARDIA_REGISTRY_WEBHOOK_SECRET` are set, tells the registry with a signed GitHub-style `release` event.

The registry ([ardia.dev/r/](https://ardia.dev/r/)) indexes the release from `plugin.json` inside the archive and
serves it signed. `workflow_dispatch` runs any tag as a dry run (the default) that publishes nothing.

## License

Apache-2.0
