# 1Password

Ardia's official 1Password plugin (`@ardia/1password`). It makes 1Password a source in Ardia's password manager: Ardia
fills logins and one-time codes from it, saves new logins into your personal vault, and updates usernames, passwords,
sites and codes. You approve Ardia in the 1Password app; there is no password to type.

## What it needs

- The 1Password app, signed in, with **Settings › Developer › Integrate with 1Password CLI** turned on.
- The 1Password CLI, `op`: `brew install 1password-cli` ([1Password's guide](https://www.1password.dev/cli/get-started/)).

## How it runs

`main` provides `credentials.provider` with `@ardia-plugins/credential-provider`, and its sidecar runs `op` only for the
verbs in [`src/spec.ts`](src/spec.ts): account list, vault list and get, item list, get, create and edit, and signout.
Passkeys stay in 1Password and go through macOS (`contributes.passwordManager.passkeys: "system"`).

- With more than one 1Password account, sign-in asks which one to use and remembers it. An approval lasts 10 minutes;
  after that, 1Password asks again.
- Edits never send a template, since `op item edit` with one overwrites the login's passkey. One `op item edit` uses
  assignment statements that change only the fields they name: `username=<value>`, `--url=<address>`,
  `<label>[delete]` for each code field, and `password=<value>` or `one-time password[otp]=<otpauth address>`, each as
  one argument behind its literal prefix (the spec's `argvSecrets`). Every edit is read back.
- When an edit fails, `link` returns the item's private link,
  `https://start.1password.com/open/i?a=<account>&v=<vault>&i=<item>&h=<sign-in host>`.

## Build and test

```sh
pnpm install
cd plugins/1password
pnpm run typecheck && pnpm test
pnpm run build && pnpm exec ardia-plugin check .
```

The tests run the provider against a fake `op` through the same command builder the sidecar uses; they never run the
real `op`.
