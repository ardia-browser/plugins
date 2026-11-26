# Proton Pass

Ardia's official Proton Pass plugin (`@ardia/proton-pass`). It adds Proton Pass as a source in Ardia's password manager:
Ardia fills your Proton Pass logins and one-time codes, and saves new logins to your personal vault.

It needs the Proton Pass CLI, `pass-cli`: `brew install protonpass/tap/pass-cli`. Ardia shows that command when it's
missing.

## Signing in

- **Sign In with Browser**: the plugin hands Ardia Proton's sign-in link and keeps `pass-cli login` running for up to
  11 minutes while you finish in the browser.
- **Access Token**: paste a Proton Pass personal access token.

If your account has an extra password, enter it in the optional Extra Password field; it reaches `pass-cli` only in its
environment. Unlocking Proton Pass in Ardia asks you to confirm, since `pass-cli` keeps its own session. Proton Pass
reads need the internet. Editing logins and adding codes to existing logins aren't available, since `pass-cli` doesn't
offer them.

## How it runs

`main` provides `credentials.provider` with `@ardia-plugins/credential-provider`, and its sidecar runs `pass-cli` only for
the verbs in [`src/spec.ts`](src/spec.ts), with its update checks and telemetry off.

## Build and test

```sh
pnpm install
cd plugins/proton-pass
pnpm run typecheck && pnpm test
pnpm run build && pnpm exec ardia-plugin check .
```
