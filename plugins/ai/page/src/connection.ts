import { ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { ChannelLink } from "./channelLink";

const BEARER_KEY = `ardia.ai.bearer.${location.port}`;
const KEY_KEY = `ardia.ai.key.${location.port}`;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function takeKeyFromFragment(): string | null {
  const match = /(?:^#|&)k=([A-Za-z0-9_-]{16,256})/.exec(location.hash);
  if (!match) return null;
  history.replaceState(history.state, "", location.pathname + location.search);
  return match[1]!;
}

async function exchange(key: string): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: key,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });
  const response = await fetch("/oauth/token", { method: "POST", body });
  if (!response.ok) return null;
  const json = (await response.json()) as { access_token?: string };
  return json.access_token ?? null;
}

async function sessionWorks(bearer: string): Promise<boolean> {
  const response = await fetch("/api/auth/session", { headers: { authorization: `Bearer ${bearer}` } });
  if (!response.ok) return false;
  return ((await response.json()) as { authenticated?: boolean }).authenticated === true;
}

export async function signIn(): Promise<string> {
  const fresh = takeKeyFromFragment();
  if (fresh) store(KEY_KEY, fresh);
  const stored = readStored(BEARER_KEY);
  if (stored && (await sessionWorks(stored))) return stored;
  for (const key of [fresh, readStored(KEY_KEY)]) {
    if (!key) continue;
    const bearer = await exchange(key);
    if (bearer) {
      store(BEARER_KEY, bearer);
      return bearer;
    }
  }
  throw new Error("This page couldn't sign in to the assistant. Reload the tab.");
}

const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;

export type Connection = {
  bearer: string;
  call<A>(make: (client: Client) => Effect.Effect<A, unknown, never>): Promise<A>;
  subscribe<A>(make: (client: Client) => Stream.Stream<A, unknown, never>, onItem: (item: A) => void, onEnd: (error: unknown) => void): () => void;
  close(): void;
};

type Recorded = { method: string; payload: unknown };

const recorder = new Proxy({}, { get: (_, method) => (payload: unknown): Recorded => ({ method: String(method), payload }) }) as unknown as Client;

export function channelConnection(link: ChannelLink): Connection {
  return {
    bearer: "",
    call: (make) => {
      const { method, payload } = make(recorder) as unknown as Recorded;
      return link.call(method, payload) as Promise<never>;
    },
    subscribe: (make, onItem, onEnd) => {
      const { method, payload } = make(recorder) as unknown as Recorded;
      return link.stream(method, payload, onItem as (item: unknown) => void, onEnd);
    },
    close: () => link.close(),
  };
}

export async function connect(bearer: string): Promise<Connection> {
  const ticketResponse = await fetch("/api/auth/websocket-ticket/rpc", { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
  if (!ticketResponse.ok) throw new Error("The assistant refused this page's session.");
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const url = new URL("/ws", location.origin.replace(/^http/, "ws"));
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  const scope = Effect.runSync(Scope.make());
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url.toString())),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  );
  const client = await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(protocol);
      return yield* makeClient.pipe(Effect.provide(context));
    }).pipe(Scope.provide(scope)),
  );
  return {
    bearer,
    call: (make) => Effect.runPromise(make(client)),
    subscribe: (make, onItem, onEnd) => {
      const fiber = Effect.runFork(Stream.runForEach(make(client), (item) => Effect.sync(() => onItem(item))));
      fiber.addObserver((exit) => {
        if (!Exit.hasInterrupts(exit)) onEnd(Exit.isFailure(exit) ? exit.cause : null);
      });
      return () => void Effect.runFork(Fiber.interrupt(fiber));
    },
    close: () => void Effect.runFork(Scope.close(scope, Exit.void)),
  };
}
