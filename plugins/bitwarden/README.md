# Bitwarden

Ardia's official Bitwarden plugin (`@ardia/bitwarden`): fills and saves logins, one-time codes and passkeys from your
Bitwarden vault, as a source inside Ardia's password manager.

It needs the Bitwarden CLI, 2024.6.0 or later: `brew install bitwarden-cli`.

## What it does

- Signs in with your email and master password (two-step login by authenticator app, email code or YubiKey), or with
  your personal API key when Bitwarden wants to verify a new Mac. Bitwarden.com, Bitwarden.eu and self-hosted servers
  (https, or http on localhost) all work.
- Unlocks with your master password, or with Touch ID, which keeps `bw`'s session in the plugin's Keychain secrets.
- Syncs at most every five minutes, and not while you're offline.
- Reads one-time codes (Bitwarden needs Premium for them), saves new logins, edits them, adds codes and stores passkeys.

## How it runs

`main` provides `credentials.provider` with `@ardia-plugins/credential-provider`. The sidecar runs `bw` only for the
verbs in [`src/spec.ts`](src/spec.ts); the master password and API key go to `bw` in its environment, never in argv, and
the session key `bw unlock` prints stays in the sidecar, reaching `bw` as `BW_SESSION`.

## Build and test

```sh
pnpm install
cd plugins/bitwarden
pnpm run typecheck && pnpm test
pnpm run build && pnpm exec ardia-plugin check .
```

The tests drive the provider through a fake `bw` and `createMockHost()`; they never run the real CLI.
