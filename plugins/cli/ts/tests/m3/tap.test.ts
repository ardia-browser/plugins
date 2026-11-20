import { afterEach, describe, expect, test } from "bun:test";
import { type Subprocess, spawn } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PORT_BASE } from "./daemon-helpers.ts";

const TAP = path.join(path.dirname(new URL(import.meta.url).pathname), "tap.ts");
const TAP_PORT = PORT_BASE + 18;
const SECRET = "s3cret-PW-123";
const USER = "alice-user";
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Upstream = { port: number; received: Record<string, unknown>[] };

function fakeChromium(): Upstream {
  const received: Record<string, unknown>[] = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv): Response | undefined {
      const url = new URL(request.url);
      if (url.pathname === "/json/version") return Response.json({ Browser: "fake", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/fake` });
      if (srv.upgrade(request, { data: undefined })) return undefined;
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        received.push(message);
        socket.send(JSON.stringify({ id: message["id"], result: {}, ...(message["sessionId"] ? { sessionId: message["sessionId"] } : {}) }));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { port: server.port as number, received };
}

async function startTap(args: string[]): Promise<{ out: string; process: Subprocess<"ignore", "pipe", "pipe"> }> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "d3-tap-"));
  const out = path.join(folder, "transcript.jsonl");
  const tap = spawn([process.execPath, TAP, "--listen", String(TAP_PORT), "--out", out, ...args], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => {
    tap.kill();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const reader = tap.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(first.value)).toContain("listening");
  return { out, process: tap };
}

async function control(pathname: string, body: unknown = {}): Promise<Record<string, unknown>> {
  return (await (await fetch(`http://127.0.0.1:${TAP_PORT}${pathname}`, { method: "POST", body: JSON.stringify(body) })).json()) as Record<string, unknown>;
}

async function client(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${TAP_PORT}/devtools/browser/tap`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  cleanups.push(() => socket.close());
  return socket;
}

async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the tap keeps each session's send order", () => {
  test("requests behind a held one on its session wait for it; other sessions don't", async () => {
    const upstream = fakeChromium();
    await startTap(["--upstream", String(upstream.port)]);
    const socket = await client();
    await settle();
    await control("/tap/fault", { kind: "hold", method: "Fetch.enable", at: 1 });
    socket.send(JSON.stringify({ id: 1, method: "Fetch.enable", sessionId: "S", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "Fetch.disable", sessionId: "S", params: {} }));
    socket.send(JSON.stringify({ id: 3, method: "Runtime.evaluate", sessionId: "T", params: { expression: "1" } }));
    await settle();
    expect(upstream.received.map((message) => message["id"])).toEqual([3]);
    expect((await control("/tap/release")).released).toBe(true);
    await settle();
    expect(upstream.received.map((message) => message["id"])).toEqual([3, 1, 2]);
  });

  test("a dropped reply holds nothing back", async () => {
    const upstream = fakeChromium();
    await startTap(["--upstream", String(upstream.port)]);
    const socket = await client();
    await settle();
    await control("/tap/fault", { kind: "drop", method: "Fetch.enable", at: 1 });
    socket.send(JSON.stringify({ id: 1, method: "Fetch.enable", sessionId: "S", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "Fetch.disable", sessionId: "S", params: {} }));
    await settle();
    expect(upstream.received.map((message) => message["id"])).toEqual([1, 2]);
  });
});

describe("recordings never hold credentials", () => {
  const auth = {
    id: 4,
    method: "Fetch.continueWithAuth",
    sessionId: "S",
    params: { requestId: "R1", authChallengeResponse: { response: "ProvideCredentials", username: USER, password: SECRET } },
  };
  const others = [
    { id: 5, method: "Network.setExtraHTTPHeaders", sessionId: "S", params: { headers: { Authorization: `Basic ${SECRET}`, "X-Plain": "kept" } } },
    { id: 6, method: "Network.setCookie", params: { name: "sid", value: SECRET, domain: "x.test" } },
    { id: 7, method: "Storage.setCookies", params: { cookies: [{ name: "sid", value: SECRET, domain: "x.test" }] } },
    { id: 8, method: "Fetch.continueRequest", sessionId: "S", params: { requestId: "R2", headers: [{ name: "Cookie", value: `sid=${SECRET}` }] } },
  ];

  test("a continueWithAuth reaches Chromium whole and is written redacted, and a replay of it still matches", async () => {
    const upstream = fakeChromium();
    const live = await startTap(["--upstream", String(upstream.port)]);
    const socket = await client();
    await settle();
    for (const message of [auth, ...others]) socket.send(JSON.stringify(message));
    await settle(300);
    expect(JSON.stringify(upstream.received)).toContain(SECRET);
    const written = fs.readFileSync(live.out, "utf8");
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain(USER);
    expect(written).toContain("<REDACTED>");
    expect(written).toContain("X-Plain");
    socket.close();
    live.process.kill();
    await live.process.exited;
    const replayed = await startTap(["--replay", live.out]);
    const again = await client();
    const answers: unknown[] = [];
    again.onmessage = (event) => answers.push(JSON.parse(String(event.data)));
    await settle();
    for (const message of [auth, ...others]) again.send(JSON.stringify(message));
    await settle(300);
    const state = (await (await fetch(`http://127.0.0.1:${TAP_PORT}/tap/state`)).json()) as { failures: string[] };
    expect(state.failures).toEqual([]);
    expect(answers).toHaveLength(1 + others.length);
    expect(fs.readFileSync(replayed.out, "utf8")).not.toContain(SECRET);
  });
});
