// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { bumpChat, handleApi, stopChat, type ApiDeps, type TurnControl } from "./ardiaApi.ts";
import { ardiaHost, type ArdiaHostHandle } from "./host.ts";
import { channelHost } from "./hostApi.ts";
import { notifyChat, pluginState } from "./state.ts";
import { turnLedger } from "./turnLedger.ts";

const verified = new Map<string, number>();
const VERIFY_TTL_MS = 60_000;
const BODY_LIMIT = 64 * 1024;

async function bearerIsValid(port: number, authorization: string | undefined): Promise<boolean> {
  if (!authorization || !/^Bearer [A-Za-z0-9._~+/=-]{16,4096}$/.test(authorization)) return false;
  const seen = verified.get(authorization);
  if (seen && Date.now() - seen < VERIFY_TTL_MS) return true;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: { authorization }, signal: AbortSignal.timeout(5000) });
    const session = (await response.json()) as { authenticated?: boolean };
    if (response.ok && session.authenticated === true) {
      verified.set(authorization, Date.now());
      return true;
    }
  } catch {}
  verified.delete(authorization);
  return false;
}

function providerBinary(provider: "claude" | "codex"): string {
  const home = process.env.HOME ?? "";
  for (const dir of [Path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    const candidate = Path.join(dir, provider);
    if (Fs.existsSync(candidate)) return candidate;
  }
  return provider;
}

export function signInScript(provider: "claude" | "codex", binary: string): string {
  const command = provider === "claude" ? `"${binary}" auth login` : `"${binary}" login`;
  return `#!/bin/sh\nclear\n${command}\necho\necho "You can close this window and go back to Ardia."\n`;
}

async function startLogin(handle: ArdiaHostHandle, provider: "claude" | "codex") {
  const dir = Path.join(handle.dataDir, "tmp");
  Fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = Path.join(dir, `sign-in-${provider}.command`);
  Fs.writeFileSync(file, signInScript(provider, providerBinary(provider)), { mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const child = ChildProcess.spawn("/usr/bin/open", ["-a", "Terminal", file], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`open exited with ${code}`))));
  });
}

let wired = false;
let turns: TurnControl | undefined;

const layerTurns = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    turns = {
      stop: (chatId) =>
        run(
          orchestrator
            .dispatch({ type: "thread.stop", commandId: CommandId.make(`ardia-stop:${Crypto.randomUUID()}`), threadId: ThreadId.make(chatId), reason: "Stopped in Ardia" })
            .pipe(Effect.asVoid),
        ),
    };
  }),
);

function depsFor(handle: ArdiaHostHandle): ApiDeps {
  const state = pluginState(handle.dataDir);
  if (!wired) {
    wired = true;
    state.asks.onChange((chatId) => bumpChat(chatId));
    handle.channel.onEvent((event) => {
      if (event.event === "plugin.values") bumpChat(null);
      if (event.event === "plugin.bannerAction") {
        const tab = String(event.data.tab ?? "");
        const chatId = state.banners.get(tab);
        if (chatId) {
          stopChat({ state, turns, ledger: turnLedger }, chatId);
          notifyChat(state, chatId, "stopped");
          state.telemetry.count("banner_stops");
        }
      }
      if (event.event === "tab.closed") state.memory.forgetTab(String(event.data.tabId ?? ""));
    });
  }
  return {
    host: channelHost(handle.channel),
    turns,
    ledger: turnLedger,
    state,
    values: () => handle.values,
    appVersion: handle.appVersion,
    workspaceRoot: handle.workspaceDir,
    openPage: (path, how) => handle.channel.request<{ tabId: string }>("page.open", { path: `/${path}`, split: how.split, ...(how.side ? { side: how.side } : {}), context: how.split }),
    setValue: async (key, value) => void (await handle.channel.request("values.set", { key, value })),
    startLogin: (provider) => startLogin(handle, provider),
    count: (counter) => state.telemetry.count(counter),
  };
}

class ArdiaApiError extends Schema.TaggedError<ArdiaApiError>()("ArdiaApiError", { message: Schema.String }) {}

const BAD_JSON = Symbol("bad json");

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return BAD_JSON;
  }
}

const json = (status: number, body: unknown) =>
  HttpServerResponse.text(JSON.stringify(body), { status, contentType: "application/json", headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const handle = ardiaHost();
  if (!handle) return json(503, { error: "Ardia isn't connected." });
  const url = new URL(request.url, `http://127.0.0.1:${handle.port}`);
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${handle.port}`) return json(403, { error: "Wrong origin." });
  const host = request.headers.host;
  if (host !== `127.0.0.1:${handle.port}`) return json(403, { error: "Wrong host." });
  const allowed = yield* Effect.promise(() => bearerIsValid(handle.port, request.headers.authorization));
  if (!allowed) return json(401, { error: "Not signed in to this runtime." });
  const text = request.method === "POST" ? yield* request.text.pipe(Effect.orElseSucceed(() => "")) : "";
  if (text.length > BODY_LIMIT) return json(413, { error: "Too large." });
  const body = parseBody(text);
  if (body === BAD_JSON) return json(400, { error: "Bad JSON." });
  const reply = yield* Effect.tryPromise({
    try: (signal) => handleApi(request.method, url.pathname, url.searchParams, body, depsFor(handle), signal),
    catch: (error) => new ArdiaApiError({ message: error instanceof Error ? error.message : "Failed." }),
  }).pipe(Effect.catch((error) => Effect.succeed({ status: 502, body: { error: error.message } })));
  return json(reply.status, reply.body);
});

export function answerPageApi(handle: ArdiaHostHandle, method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal) {
  const url = new URL(path, `http://127.0.0.1:${handle.port}`);
  return handleApi(method, url.pathname, url.searchParams, body, depsFor(handle), signal);
}

export const layer = Layer.mergeAll(HttpRouter.add("GET", "/ardia/*", handler), HttpRouter.add("POST", "/ardia/*", handler), layerTurns);

export function requestAllowed(headers: Record<string, string | undefined>, port: number): boolean {
  const own = `127.0.0.1:${port}`;
  if (headers.host !== own) return false;
  if (headers["x-forwarded-host"] !== undefined || headers.forwarded !== undefined) return false;
  const origin = headers.origin;
  return origin === undefined || origin === `http://${own}`;
}

export const layerGuard = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const handle = ardiaHost();
      if (!handle) return yield* httpEffect;
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!requestAllowed(request.headers, handle.port)) return json(403, { error: "This runtime only answers its own page on 127.0.0.1." });
      return yield* httpEffect;
    }),
  { global: true },
);
