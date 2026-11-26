# AI

`@ardia/ai` asks Claude about the page you're on, right from the command bar, and answers other plugins through the
`ai.provider` interface. It runs on your own Anthropic API key and is off until you turn it on in **Settings › Plugins**.

## Use it

1. Run **AI: Set Anthropic API Key** from the command bar and paste a key from
   [console.anthropic.com](https://console.anthropic.com). Ardia keeps it in your Keychain.
2. Press Tab in the command bar to switch to **Ask AI** (or press ⌘⇧E), type a question and press Return. The answer
   streams in as Claude writes it, with **Copy Answer**, **Ask Again** and **Set API Key**.

**AI: Forget Anthropic API Key** deletes the key.

| Setting | What it does |
|---|---|
| Model | Claude Haiku 5.5, Claude Sonnet 5.5 (the default) or Claude Opus 5.5 |
| Include the Page You're On | On by default: Ask AI sends the page's text with your question |

## `ai.provider`

Other plugins list `"consumes": ["ai.provider"]` in `plugin.json` and call it through `ardia.services`:

```ts
const { text } = await ardia.services.call<{ text: string }>("ai.provider", "complete", { prompt: "Say hi" });
```

| Method | Input | Result |
|---|---|---|
| `complete` | `{ prompt: string, system?: string, model?: string, maxTokens?: number }` | `{ text: string, model: string, stopReason: string \| null }` |
| `models` | none | `{ models: { id: string, name: string }[], default: string }` |

- `model` is one of the ids `models` lists; anything else falls back to the Model setting.
- `maxTokens` defaults to 16000 and is held to 1 through 64000.
- Cancelling the call cancels the request to Anthropic.
- Errors say what to do: no key or a rejected key (run **AI: Set Anthropic API Key**), rate limited, overloaded,
  Anthropic unavailable, a refused request or a declined answer.

## Permissions

| Permission | Why |
|---|---|
| `activePage.read` | Ask AI reads the page you're on, when you ask and only with Include the Page on |
| `network: api.anthropic.com` | The only place it sends anything |
| `secrets` | Your API key, in the Keychain |

## Privacy

Your question, and the page's title, address and text when Include the Page is on, go to Anthropic's Messages API with
your key, under your Anthropic account's terms. Nothing goes anywhere else, and the plugin keeps no history: closing
the answer cancels it and forgets it.

## Develop

```sh
pnpm install
pnpm --filter @ardia-plugins/ai test
pnpm --filter @ardia-plugins/ai exec ardia-plugin dev
```

`src/plugin.tsx` builds the plugin from the `ardia` it's given, so tests run it on `createMockHost()` from
`@ardia/plugin-sdk/testing`.
