import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { announcePath } from "../src/browse/daemon/announce.ts";
import { controlFilePath, DEVTOOLS_ENDPOINT_METHOD, type EndpointCall, EndpointError, fromControl, readControlFile, resolveInstance } from "../src/browse/endpoint.ts";
import { ControlRefused, controlCall, MethodUnknown, NotConnected } from "../src/browse/state/apptabs.ts";

const FILE_TOKEN = "f".repeat(32);
const SOCKET_TOKEN = "s".repeat(43);

function writeControl(root: string, fields: Record<string, unknown>): string {
  const file = controlFilePath(root);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, "w", 0o600);
  writeSync(fd, JSON.stringify({ port: 9222, browser: "/devtools/browser/abc-123", pid: process.pid, generation: 3, ...fields }));
  closeSync(fd);
  return file;
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "dte-"));
}

const answers = (answer: unknown): EndpointCall => async () => answer;
const refusing = (code: string, message: string): EndpointCall => async () => {
  if (code === "not_connected") throw new NotConnected(message);
  if (code === "unknown_method") throw new MethodUnknown(message);
  throw new ControlRefused(code, message);
};

test("the token comes from the control socket, and the file needn't hold one", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, {});
    let asked = "";
    const endpoint = await fromControl(file, null, async (socketFile) => {
      asked = socketFile;
      return { port: 9222, token: SOCKET_TOKEN, generation: 3 };
    });
    assert.equal(asked, announcePath(file));
    assert.equal(endpoint.ws, `ws://127.0.0.1:9222/devtools/browser/abc-123?token=${SOCKET_TOKEN}`);
    assert.equal(endpoint.active, `http://127.0.0.1:9222/ardia/active?token=${SOCKET_TOKEN}`);
    assert.equal(readControlFile(file).token, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an Ardia without the method falls back to the file's token", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, { token: FILE_TOKEN });
    const endpoint = await fromControl(file, null, refusing("unknown_method", `unknown method ${DEVTOOLS_ENDPOINT_METHOD}`));
    assert.match(endpoint.ws, new RegExp(`token=${FILE_TOKEN}$`));
    const notConnected = await fromControl(file, null, refusing("not_connected", "the control socket isn't there"));
    assert.match(notConnected.ws, new RegExp(`token=${FILE_TOKEN}$`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a program Ardia turns away never falls back to the file, even when it holds a token", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, { token: FILE_TOKEN });
    await assert.rejects(fromControl(file, null, refusing("refused", "Not allowed")), (error: Error) => error instanceof EndpointError && /didn't let this program control it/.test(error.message) && !error.message.includes(FILE_TOKEN));
    await assert.rejects(fromControl(file, null, refusing("failed", "Control is off.")), (error: Error) => error instanceof EndpointError && error.message.includes("Control is off."));
    for (const code of ["unreachable", "timeout", "bad_reply"]) {
      await assert.rejects(fromControl(file, null, refusing(code, "after connecting")), (error: Error) => error instanceof EndpointError && !error.message.includes(FILE_TOKEN), code);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without the method and without a token in the file, it says so", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, {});
    await assert.rejects(fromControl(file, null, refusing("unknown_method", "x")), /has no valid token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an answer from another server generation is refused, and a bad answer is too", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, {});
    await assert.rejects(fromControl(file, null, answers({ port: 9222, token: SOCKET_TOKEN, generation: 4 })), /restarted its DevTools connection/);
    await assert.rejects(fromControl(file, null, answers({ port: 9222, token: "short", generation: 3 })), /without a valid port, token and generation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function serveLines(file: string, lines: (request: Record<string, unknown>) => string[]): Promise<Server> {
  const server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
        buffer = buffer.slice(at + 1);
        for (const line of lines(request)) connection.write(`${line}\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(file, () => resolve(server)));
}

test("the doorbell's refusal (id null, refused) reaches the caller as refused, not as a closed socket", async () => {
  const root = scratch();
  const socketFile = path.join(root, "ArdiaControl.sock");
  const server = await serveLines(socketFile, (request) =>
    request["method"] === "hello" ? [JSON.stringify({ id: null, error: { code: "refused", message: "Ardia turned this program away" } })] : [],
  );
  try {
    await assert.rejects(controlCall(socketFile, null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), (error: Error) => error instanceof ControlRefused && error.code === "refused");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("over a real socket the method's answer is read and an unknown method is told apart", async () => {
  const root = scratch();
  const socketFile = path.join(root, "ArdiaControl.sock");
  let known = true;
  const server = await serveLines(socketFile, (request) => {
    if (request["method"] === "hello") return [JSON.stringify({ id: request["id"], result: { app: "Ardia", version: "0.2.49", protocol: 4 } })];
    if (!known) return [JSON.stringify({ id: request["id"], error: { code: "unknown_method", message: "unknown method" } })];
    return [JSON.stringify({ id: request["id"], result: { port: 9222, token: SOCKET_TOKEN, generation: 3 } })];
  });
  try {
    assert.deepEqual(await controlCall(socketFile, null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), { port: 9222, token: SOCKET_TOKEN, generation: 3 });
    known = false;
    await assert.rejects(controlCall(socketFile, null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), (error: Error) => error instanceof ControlRefused && error.code === "unknown_method");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a socket that isn't there is not_connected, and one that closes after connecting is unreachable", async () => {
  const root = scratch();
  try {
    await assert.rejects(controlCall(path.join(root, "ArdiaControl.sock"), null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), (error: Error) => error instanceof ControlRefused && error.code === "not_connected");
    const socketFile = path.join(root, "ArdiaControl.sock");
    const server = createServer((connection) => connection.once("data", () => connection.end()));
    await new Promise<void>((resolve) => server.listen(socketFile, () => resolve()));
    try {
      await assert.rejects(controlCall(socketFile, null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), (error: Error) => error instanceof ControlRefused && error.code === "unreachable");
    } finally {
      server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a different port means another server, even with the same generation", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, {});
    await assert.rejects(fromControl(file, null, answers({ port: 9333, token: SOCKET_TOKEN, generation: 3 })), /restarted its DevTools connection/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the idle check reads only the file's identity and never asks the socket", async () => {
  const root = scratch();
  try {
    writeControl(root, {});
    assert.equal(await resolveInstance({ data_dir: root }), `${process.pid}:3:/devtools/browser/abc-123`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reply to the method before hello succeeded is ignored, and a frame that isn't JSON is bad_reply", async () => {
  const root = scratch();
  const early = path.join(root, "early.sock");
  const server = await serveLines(early, (request) =>
    request["method"] === "hello"
      ? [JSON.stringify({ id: 2, result: { port: 1, token: "x".repeat(32), generation: 9 } }), JSON.stringify({ id: 1, result: { app: "Ardia", protocol: 4 } })]
      : [JSON.stringify({ id: request["id"], result: { port: 9222, token: SOCKET_TOKEN, generation: 3 } })],
  );
  const garbled = path.join(root, "garbled.sock");
  const other = await serveLines(garbled, () => ["not json"]);
  try {
    assert.deepEqual(await controlCall(early, null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), { port: 9222, token: SOCKET_TOKEN, generation: 3 });
    await assert.rejects(controlCall(garbled, null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), (error: Error) => error instanceof ControlRefused && error.code === "bad_reply");
  } finally {
    server.close();
    other.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fractional port or generation is a bad answer, not a RangeError", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, {});
    await assert.rejects(fromControl(file, null, answers({ port: 9222, token: SOCKET_TOKEN, generation: 3.5 })), /without a valid port, token and generation/);
    await assert.rejects(fromControl(file, null, answers({ port: 9222.5, token: SOCKET_TOKEN, generation: 3 })), /without a valid port, token and generation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the idle check accepts an unsignalable pid without touching the socket", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, {});
    const eperm = () => {
      const error: NodeJS.ErrnoException = new Error("EPERM");
      error.code = "EPERM";
      throw error;
    };
    assert.equal(readControlFile(file, eperm, false).pid, BigInt(process.pid));
    assert.throws(() => readControlFile(file, eperm), /can't be signalled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a control socket path that isn't a socket is unsafe and never falls back", async () => {
  const root = scratch();
  try {
    const file = writeControl(root, { token: FILE_TOKEN });
    const fake = announcePath(file);
    writeFileSync(fake, "not a socket");
    await assert.rejects(controlCall(fake, null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), (error: Error) => error instanceof ControlRefused && error.code === "unsafe");
    await assert.rejects(fromControl(file, null), (error: Error) => error instanceof EndpointError && !error.message.includes(FILE_TOKEN));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codes the server sends never pick the fallback: not_connected after hello, unknown_method before it", async () => {
  const root = scratch();
  try {
    for (const [code, beforeHello] of [["not_connected", false], ["unknown_method", true], ["not_connected", true]] as const) {
      const socketFile = path.join(root, `${code}-${beforeHello}.sock`);
      const server = await serveLines(socketFile, (request) => {
        if (beforeHello && request["method"] === "hello") return [JSON.stringify({ id: null, error: { code, message: "x" } })];
        if (request["method"] === "hello") return [JSON.stringify({ id: request["id"], result: { app: "Ardia", protocol: 4 } })];
        return [JSON.stringify({ id: request["id"], error: { code, message: "x" } })];
      });
      try {
        await assert.rejects(controlCall(socketFile, null, DEVTOOLS_ENDPOINT_METHOD, null, 5, null), (error: Error) => error instanceof ControlRefused && !(error instanceof NotConnected) && !(error instanceof MethodUnknown));
      } finally {
        server.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
