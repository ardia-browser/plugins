# @ardia-plugins/credential-provider

The shared code behind the official password manager plugins (`@ardia/1password`, `@ardia/bitwarden`,
`@ardia/proton-pass`). It's a private workspace package that each plugin bundles; it never ships on its own and it
doesn't copy `@ardia/plugin-sdk`, which every plugin imports directly.

A password manager plugin has two halves:

- **main** (`dist/index.js`, sandboxed JavaScript) calls `createCredentialProvider(ardia, { id, spec, info, provider })`,
  which provides the `credentials.provider` service. Every method answers `{ ok: true, result }` or
  `{ ok: false, error: { code, problem?, detail?, state?, field? } }`, and `describe` returns the provider's title,
  capabilities, sign-in methods, servers and CLI install command.
- **the sidecar** (`sidecar/server.mjs`, Node) calls `runCredentialSidecar(spec)` and is the only part that runs the vendor's
  CLI. It reads JSON lines `{ id, method, params }` on stdin and answers `{ id, result }` or `{ id, error: { code, message } }`.

## The CLI spec

`defineCliSpec()` checks the spec once, at load, and both halves use the same object. A spec names the program, how to
install it, its id patterns, its environment and its verbs. Each verb is an argv template with typed slots (`id`,
`enum`, `flag`, `url`, `email`, `code`, `secret`, `json`), a timeout, an output limit and mode (`json`, `lines`,
`lastLineSecret`, `stream`), and the stderr hints that classify a failure. The checks refuse:

- commands that run other programs, write files, open servers or share data (`op run`, `bw serve`, `pass-cli inject`, …),
- a secret in argv unless the verb says `argvSecrets` and puts it behind a literal prefix,
- environment variables Ardia sets or never passes (`PATH`, `HOME`, `DYLD_*`, `NODE_*`, proxies, …),
- unused or doubly used slots, regular expressions that aren't anchored, and unknown keys.

The sidecar builds every command from the spec again, so a value that doesn't fit its slot (an id starting with `-`, an
http address that isn't this Mac, a line break) is refused before anything runs. It spawns the program without a shell,
from `PATH` or `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` and `~/.local/bin`, with only Ardia's host
environment plus the spec's, kills it at its timeout, caps its output and redacts every secret it was given.

## Sidecar methods

| Method | What it does |
| --- | --- |
| `cli.run` `{ verb, params, timeoutMs? }` | Runs a verb and answers its result: `status`, `succeeded`, `timedOut`, `stderr`, `hints`, `json`, `lines`, `items`, `unlocked`, `signInRun`; `persist` for a persistent session; `running` for a stream verb still going |
| `cli.wait` `{ run, waitMs? }` | Waits for more lines from a running stream verb, or its end |
| `session.status` | `{ unlocked, signInRun, cli: { name, found } }` |
| `session.offer` / `session.adopt` | Holds a stored session for one check, then keeps it once the provider says it's good |
| `session.open` / `session.drop` | Opens the session after an approved sign-in, or forgets it |
| `signIn.cancel` | Stops a sign-in that is still running |

The session a verb unlocks stays in the sidecar; later verbs name it as `{ "$secret": "session" }`. With
`persistSessions` and Touch ID, a `lastLineSecret` session is also kept in the plugin's Keychain secrets.

## Tests

```sh
pnpm --filter @ardia-plugins/credential-provider test
```

`@ardia-plugins/credential-provider/testing` has `fakeSidecar()` and `credentialHarness()`: the real sidecar core with a
fake CLI behind it, on `createMockHost()` from `@ardia/plugin-sdk/testing`.
