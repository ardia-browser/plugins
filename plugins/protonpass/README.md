# Proton Pass

Ardia's official Proton Pass plugin. It adds Proton Pass as a source in Ardia's password manager: Ardia fills your
Proton Pass logins and one-time codes, and saves new logins to your personal vault.

## What it needs

- Ardia on macOS.
- The Proton Pass CLI, `pass-cli`:

  ```sh
  brew install protonpass/tap/pass-cli
  ```

  Ardia finds it on its own and shows this command in Settings when it's missing.

## Signing in

In Settings › Passwords › Password Managers, choose Add Password Manager…, then Proton Pass. Sign in either way:

- **Sign In with Browser**: Ardia opens Proton's sign-in page in a new tab and waits up to 11 minutes for you to finish.
- **Access Token**: paste a Proton Pass personal access token.

If your account has an extra password, enter it in the optional Extra Password field. Ardia's secure fields hand what
you type straight to `pass-cli`; the plugin never sees it. Unlocking Proton Pass in Ardia asks for Touch ID or your Mac
password, since `pass-cli` keeps its own session.

Proton Pass reads need the internet, so Ardia doesn't refresh it while you're offline. Editing logins and adding codes
to existing logins aren't available yet, since `pass-cli` doesn't offer them.

Passkeys sign in and save through the Proton Pass browser extension, so their private keys never leave Proton. Ardia
lists your Proton passkeys in its sign-in sheet and fill menu, from the names and ids `pass-cli` lists with each login.

## Build and test

```sh
cd plugins/protonpass/main
npm ci
npm run typecheck
npm test
cd .. && ./build.sh ../../out
```

`build.sh` leaves `protonpass-plugin-<version>.tar.gz` and its `.sha256` in the out folder. The plugin is JavaScript
only, so the one artifact works on every Mac.

The tests run every call against a fake `pass-cli`, through the same argv and environment builder Ardia uses, and never
start the real CLI. To try the plugin in Ardia, build it, then start a hidden test instance with its own data folder
(`ARDIA_BACKGROUND=1`, `ARDIA_DATA_DIR`) and an official-plugins pin that points at your build. In a test instance
`pass-cli` keeps its session in that data folder and its keys in a file there, never in your Keychain.
