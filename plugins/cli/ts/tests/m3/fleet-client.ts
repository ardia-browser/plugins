#!/usr/bin/env bun
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { dumps, type JsonObject, type Value } from "../../src/json.ts";
import { loadLibc } from "../../src/libc.ts";
import { browseDir, closeFd, listNames, lockHeld, readPrivateJson, sessionKey, socketIsOurs } from "../../src/browse/paths.ts";
import { awaitDaemon, type DaemonChoice, daemonKind, spawnDaemon } from "../../src/browse/daemon/spawn.ts";
import { BUILT_LIBC } from "../libc-loaded.ts";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const BOOT = `
import base64, io, json, random, secrets, sys
sys.path.insert(0, ${JSON.stringify(CLI)})
text = sys.stdin.read()
config = json.loads(text or "{}")
seed = config.get("harness_seed")
if seed is not None:
    random.seed(seed)
    tokens = random.Random(seed + 1)
    secrets.token_bytes = lambda n=32: tokens.randbytes(n)
    secrets.token_hex = lambda n=32: tokens.randbytes(n).hex()
    secrets.token_urlsafe = lambda n=32: base64.urlsafe_b64encode(tokens.randbytes(n)).rstrip(b"=").decode("ascii")
sys.stdin = io.StringIO(text)
from ardia_cli.browse import daemon
daemon.main()
`;
const VALUE_FLAGS = new Set(["--port", "--data-dir", "--session"]);
const BOOL_FLAGS = new Set(["--json", "--no-changes", "--full"]);

loadLibc(BUILT_LIBC);

function parse(argv: string[]): { found: Record<string, string | boolean>; rest: string[] } {
  const found: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    if (VALUE_FLAGS.has(token)) {
      found[token.slice(2).replaceAll("-", "_")] = argv[index + 1] as string;
      index += 1;
    } else if (BOOL_FLAGS.has(token)) found[token.slice(2).replaceAll("-", "_")] = true;
    else rest.push(token);
  }
  return { found, rest };
}

function connectTo(file: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(file);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(null));
  });
}

async function connectSession(dir: number, root: string, key: string): Promise<net.Socket | null> {
  if (socketIsOurs(`${key}.sock`, dir) === null) return null;
  return connectTo(path.join(root, "Browse", `${key}.sock`));
}

function exchange(socket: net.Socket, request: JsonObject): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunk.at(-1) === 0x0a) socket.end();
    });
    socket.once("close", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.endsWith("\n")) reject(new Error("the ardia browse daemon closed the connection without answering"));
      else resolve(JSON.parse(raw) as Record<string, unknown>);
    });
    socket.once("error", reject);
    socket.write(`${dumps(request, "spaced")}\n`);
  });
}

function record(request: JsonObject, answer: Record<string, unknown>): void {
  const file = process.env["ARDIA_M3_ANSWERS"];
  if (!file) return;
  const wire = JSON.parse(dumps(request, "compact")) as Record<string, unknown>;
  const subset = Object.fromEntries(["argv", "options", "stdin", "beside_if_busy", "patient_queue"].map((key) => [key, wire[key] ?? null]));
  fs.appendFileSync(file, `${JSON.stringify({ request: subset, answer, wire })}\n`);
}

function choice(): DaemonChoice {
  if (daemonKind() === "ts") return { kind: "ts", program: process.env["ARDIA_M3_TS_PROGRAM"] as string };
  return { kind: "python", python: process.env["ARDIA_TEST_PYTHON"] ?? "python3", code: BOOT };
}

function options(session: string, found: Record<string, string | boolean>): JsonObject {
  return new Map<string, Value>([
    ["json", Boolean(found["json"])],
    ["humanize", false],
    ["timeout_ms", 25000n],
    ["max_output", null],
    ["full", Boolean(found["full"])],
    ["no_changes", Boolean(found["no_changes"])],
    ["no_text", false],
    ["content_boundaries", false],
    ["annotate", false],
    ["screenshot_dir", null],
    ["screenshot_format", null],
    ["screenshot_quality", null],
    ["no_auto_dialog", false],
    ["capture_console", null],
    ["show", null],
    ["enable", []],
    ["init_scripts", []],
    ["_session", session],
  ]);
}

function request(argv: string[], opts: JsonObject): JsonObject {
  const env = new Map<string, Value>(Object.entries(process.env).filter(([name]) => name.startsWith("AGENT_BROWSER_")) as [string, string][]);
  return new Map<string, Value>([
    ["argv", argv],
    ["options", opts],
    ["cwd", process.cwd()],
    ["env", env],
    ["stdin", null],
    ["telemetry", false],
    ["caller", new Map([["name", "fleet-client"]])],
  ]);
}

async function closeAll(dir: number, root: string): Promise<number> {
  const closed: string[] = [];
  for (const entry of listNames(dir).sort()) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    const key = entry.slice(0, -5);
    if (!lockHeld(`${key}.lock`, dir)) continue;
    const meta = readPrivateJson(entry, dir);
    const socket = await connectSession(dir, root, key);
    if (socket === null || !(meta instanceof Map)) continue;
    try {
      const sent = new Map<string, Value>([["argv", ["close"]], ["options", new Map()], ["cwd", process.cwd()], ["env", new Map()], ["stdin", null]]);
      await exchange(socket, sent);
      closed.push(String(meta.get("session")));
    } catch {}
  }
  process.stdout.write(`✓ Closed ${closed.length} session${closed.length !== 1 ? "s" : ""}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] !== "browse") throw new Error("fleet-client serves only `browse`");
  const { found, rest } = parse(argv.slice(1));
  const session = String(found["session"] ?? "default");
  const port = Number(found["port"]);
  const root = String(found["data_dir"]);
  const key = sessionKey("", `port:${port}`, session);
  const dir = browseDir(root);
  try {
    if (rest[0] === "close" && rest.includes("--all")) return await closeAll(dir, root);
    let socket = await connectSession(dir, root, key);
    if (socket === null) {
      const config = new Map<string, Value>([
        ["session", session],
        ["namespace", ""],
        ["key", key],
        ["data_root", root],
        ["ws", null],
        ["port", BigInt(port)],
        ["data_dir", root],
        ["endpoint_label", `--port ${port}`],
        ["idle_timeout_ms", null],
        ["debug", false],
        ["no_auto_dialog", false],
        ["pin_tab", null],
      ]);
      if (process.env["ARDIA_M3_SEED"] !== undefined) config.set("harness_seed", BigInt(process.env["ARDIA_M3_SEED"]));
      const home = process.env["HOME"];
      if (home) fs.appendFileSync(path.join(home, "spawn-config.jsonl"), `${dumps(config, "spaced")}\n`);
      socket = await awaitDaemon(dir, key, spawnDaemon(dir, key, config, choice()), () => connectSession(dir, root, key));
    }
    const sent = request(rest, options(session, found));
    const answer = await exchange(socket, sent);
    record(sent, answer);
    process.stdout.write(String(answer["out"] ?? ""));
    process.stderr.write(String(answer["err"] ?? ""));
    return Number(answer["exit"] ?? 0);
  } finally {
    closeFd(dir);
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
  return 2;
});
