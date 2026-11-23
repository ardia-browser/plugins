# 1Password

Ardia's official 1Password plugin. It makes 1Password a source inside Ardia's password manager: Ardia fills logins
and one-time codes from it, saves new logins into your personal vault, and updates passwords, sites and codes. You
approve Ardia in the 1Password app; there is no password to type.

## What it needs

- The 1Password app, signed in, with **Settings › Developer › Integrate with 1Password CLI** turned on.
- The 1Password CLI, `op`: `brew install 1password-cli` ([1Password's guide](https://www.1password.dev/cli/get-started/)).

Ardia runs `op` only for the commands this plugin's manifest lists (account list, vault list and get, item list, get,
create and edit, signout), builds every command itself, and never lets the plugin run anything else. Passkeys stay in
1Password; `op` doesn't expose them.

With more than one 1Password account, sign-in asks which one to use and remembers it. An approval lasts 10 minutes
for reads Ardia starts in the background; after that, 1Password asks again.

## Build and test

```sh
cd plugins/1password/main
npm ci
npm run typecheck
npm test
```

The tests run the provider against a fake `op` through the same command builder Ardia uses, and load the built
`dist/main.js` in a sandbox to check what it says on Ardia's channel. They never run the real `op`.

`plugins/1password/build.sh <out dir>` builds the folder and `1password-plugin-<version>.tar.gz` with its `.sha256`.

## Try it in a test Ardia

Build the tarball into a folder, write a test pin that names `1password-plugin-<version>.tar.gz` and its SHA-256, and
start a hidden test instance that reads the pin and fetches from that folder instead of GitHub:

```sh
plugins/1password/build.sh /tmp/ardia-1password
open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR=/tmp/ardia-1password-data --env ARDIA_REMOTE_DEBUGGING_PORT=9333 \
  --env "ARDIA_TEST=officialPin=/tmp/ardia-1password/official-plugins.json" \
  --env "ARDIA_INSTANCE=officialPluginsFrom=/tmp/ardia-1password" <Ardia test build>.app
```

Then add it from Settings › Passwords › Password Managers › Add Password Manager. In a hidden test instance `op`
keeps its config in the instance's own folder (`OP_CONFIG_DIR`), so it never touches your real 1Password CLI settings.
