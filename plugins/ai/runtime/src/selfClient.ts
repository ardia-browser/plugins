// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import { ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/rpc";

const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;

export type SelfClient = {
  call(method: string, payload: unknown): Promise<unknown>;
  stream(method: string, payload: unknown, onItem: (item: unknown) => void, onEnd: (error: unknown) => void): () => void;
};

async function bearerFor(port: number, token: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: token,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });
  const response = await fetch(`http://127.0.0.1:${port}/oauth/token`, { method: "POST", body, headers: { origin: `http://127.0.0.1:${port}` } });
  if (!response.ok) throw new Error(`The runtime refused its own sign-in (${response.status}).`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function connect(port: number, token: string): Promise<{ client: Client; scope: Scope.Closeable }> {
  const bearer = await bearerFor(port, token);
  const ticketResponse = await fetch(`http://127.0.0.1:${port}/api/auth/websocket-ticket/rpc`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
  if (!ticketResponse.ok) throw new Error("The runtime refused its own session.");
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const url = new URL(`ws://127.0.0.1:${port}/ws`);
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  const scope = Scope.makeUnsafe();
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
  return { client, scope };
}

export function selfClient(port: number, token: () => string): SelfClient {
  let live: Promise<{ client: Client; scope: Scope.Closeable }> | null = null;
  const client = () => {
    live ??= connect(port, token()).catch((error: unknown) => {
      live = null;
      throw error;
    });
    return live.then((l) => l.client as unknown as Record<string, (payload: unknown) => unknown>);
  };
  return {
    call: async (method, payload) => {
      const c = await client();
      const fn = c[method];
      if (!fn) throw new Error(`No such runtime method: ${method}`);
      return Effect.runPromise(fn(payload) as Effect.Effect<unknown, Error, never>);
    },
    stream: (method, payload, onItem, onEnd) => {
      let fiber: Fiber.Fiber<unknown, unknown> | null = null;
      let cancelled = false;
      void client().then(
        (c) => {
          if (cancelled) return;
          const fn = c[method];
          if (!fn) return onEnd(new Error(`No such runtime method: ${method}`));
          fiber = Effect.runFork(Stream.runForEach(fn(payload) as Stream.Stream<unknown, Error, never>, (item) => Effect.sync(() => onItem(item))));
          fiber.addObserver((exit) => {
            if (!Exit.hasInterrupts(exit)) onEnd(Exit.isFailure(exit) ? exit.cause : null);
          });
        },
        (error) => onEnd(error),
      );
      return () => {
        cancelled = true;
        if (fiber) void Effect.runFork(Fiber.interrupt(fiber));
      };
    },
  };
}
