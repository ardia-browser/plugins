# Bitwarden

Ardia's official Bitwarden plugin: fills and saves logins, one-time codes and passkeys from your Bitwarden vault,
as a source inside Ardia's own password manager. Find it in **Settings › Passwords › Password Managers › Add
Password Manager…**.

It needs the Bitwarden CLI, 2024.6.0 or later:

```sh
brew install bitwarden-cli
```

What it does:

- Signs in with your email and master password (two-step login by authenticator app, email code or YubiKey), or with
  your personal API key when Bitwarden wants to verify a new Mac. Bitwarden.com, Bitwarden.eu and self-hosted servers
  (https, or http on localhost) all work.
- Unlocks with your master password, or with Touch ID, which keeps bw's session in your Keychain.
- Syncs at most every five minutes, and not while you're offline. Big vaults stream in item by item.
- Reads one-time codes (Bitwarden needs Premium for them), saves new logins, edits them, adds codes and stores passkeys.

It runs `bw` only through the commands its `plugin.json` lists. What you type in its secret fields goes to `bw`, never
to the plugin. It has no permissions and contributes nothing else.

## Build and test

```sh
cd plugins/bitwarden/main
npm ci && npm run typecheck && npm run build && npm test
plugins/bitwarden/build.sh <out dir>
```

The tests drive the provider through a fake `bw` and a fake Ardia host speaking the credentials protocol; they never
run the real CLI. `build.sh` writes `<out dir>/bitwarden` and `bitwarden-plugin-<version>.tar.gz` with its `.sha256`.

## Try it in a test Ardia

Ardia runs password manager plugins only from its official copies, so point a hidden test instance at this build as
its official Bitwarden plugin (the test pin Ardia's own tests use), with its data in a scratch folder:

```sh
open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR=<scratch dir> --env ARDIA_REMOTE_DEBUGGING_PORT=<port> <Ardia.app>
```

In a hidden test instance `bw` keeps its data in `<scratch dir>/Password Managers/bitwarden`
(`BITWARDENCLI_APPDATA_DIR`), so a test account never touches your own.
