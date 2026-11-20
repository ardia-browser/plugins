import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { type JsonObject, type Value } from "../../src/json.ts";
import { browseDir, closeFd, socketIsOurs } from "../../src/browse/paths.ts";
import { awaitDaemon, spawnDaemon } from "../../src/browse/daemon/spawn.ts";
import { credentialId, pluginSessionKey } from "../../src/browse/plugin/key.ts";
import { type Entry } from "./canon.ts";
import { connectTo, PROGRAM, raw, scratch, type Scratch, TS_DIR } from "./daemon-helpers.ts";

export const CHROME = process.env["ARDIA_M3_CHROME"];
export const CREDENTIAL = "p.Ab3_-9xYz0Ab3_-9xYz0Ab3_-9xYz0Ab3_-9xYz0Q7w";
export const OTHER_CREDENTIAL = "p.Zz9_-9xYz0Ab3_-9xYz0Ab3_-9xYz0Ab3_-9xYz0Q7w";

export const FORM = `<!doctype html><title>Form page</title>
<h1>Sign up</h1>
<label>Name <input placeholder="Your name"></label>
<button onclick="document.title='Pressed'; document.getElementById('status').textContent='Saved'">Save</button>
<a href="/done">Next</a>
<p id="status"></p>
<div id="list" style="height:60px;overflow:auto"><p>one</p><p>two</p><p>three</p><p>four</p><p>five</p><p>six</p></div>
<p id="hidden" style="display:none">Hidden note</p>`;
export const CONTRACT = `<!doctype html><title>Form page</title>
<h1>Sign up</h1>
<label>Name <input></label>
<button onclick="document.title='Pressed'; document.body.insertAdjacentHTML('beforeend', '<p>Saved</p>')">Save</button>
<a href="/done">Next</a>
<div id="list" style="height:40px;overflow:auto"><div style="height:200px"></div></div>`;
export const SECRET = "hunter2-SECRET-7731";
export const LOGIN = `<!doctype html><title>Form page</title><form id="login">
<label>Username <input id="user" autocomplete="username"></label>
<label>Password <input id="pw" type="password" value="attr-${SECRET}"></label>
</form><iframe src="/login-frame"></iframe>
<script>document.getElementById('user').value = 'ada'; document.getElementById('pw').value = '${SECRET}';</script>`;
export const LOGIN_FRAME = `<!doctype html><title>Frame login</title><label>Frame password <input id="fpw" type="text" value="attr-${SECRET}"></label>
<script>const field = document.getElementById('fpw'); field.type = 'password'; field.value = '${SECRET}';</script>`;
export const FAR = `<!doctype html><title>Form page</title><h1>Far</h1><div style="height:2500px"></div>
<button onclick="document.title='Far pressed'">Far</button>
<button style="position:fixed;left:10px;top:5000px">Stuck</button>`;
export const CHILD = `<!doctype html><title>Child</title><button onclick="parent.document.title='Child pressed'">Inner</button>`;
export function framesPage(port: number): string {
  return `<!doctype html><title>Form page</title><h1>Frames</h1><iframe src="/child"></iframe><iframe src="http://localhost:${port}/child"></iframe>`;
}
export const DONE = `<!doctype html><title>Done</title><h1>All done</h1>`;

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 500, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitFor(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} didn't come up in ${ms} ms`);
}

export type World = {
  found: Scratch;
  chromePort: number;
  tapPort: number;
  sitePort: number;
  endpoint: string;
  transcript: string;
  key: string;
  daemonPid: number;
  daemons: { key: string; pid: number }[];
  children: ChildProcess[];
  site: http.Server;
};

export const FULL_CHROME = process.env["ARDIA_F1_CHROME"];

export async function startWorld(base: number, credential = CREDENTIAL, session = "plugin-ai", form = FORM, full = false): Promise<World> {
  const found = scratch();
  const [chromePort, tapPort, sitePort] = [base, base + 1, base + 2];
  const children: ChildProcess[] = [];
  const site = http.createServer((request, response) => {
    const body = request.url === "/done" ? DONE : request.url === "/contract" ? CONTRACT : request.url === "/frames" ? framesPage(sitePort) : request.url === "/child" ? CHILD : request.url === "/far" ? FAR : request.url === "/login" ? LOGIN : request.url === "/login-frame" ? LOGIN_FRAME : form;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(body);
  });
  await new Promise<void>((resolve) => site.listen(sitePort, "127.0.0.1", resolve));
  const chrome = spawn(
    (full ? FULL_CHROME : CHROME) as string,
    [full ? "--headless=new" : "--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--mute-audio",
      "--window-size=1000,800", `--remote-debugging-port=${chromePort}`, `--user-data-dir=${path.join(found.root, "profile")}`, `http://127.0.0.1:${sitePort}/form`],
    { stdio: "ignore", detached: true },
  );
  children.push(chrome);
  await waitFor(() => answers(chromePort), 30_000, "headless Chrome");
  const transcript = path.join(found.root, "transcript.jsonl");
  const tap = spawn(process.execPath, [path.join(TS_DIR, "tests", "m3", "tap.ts"), "--listen", String(tapPort), "--out", transcript, "--upstream", String(chromePort), "--chrome-pid", String(chrome.pid), "--emulate-dispatch-click", "1", "--emulate-act-hold", "1", "--emulate-hidden-wheel-refusal", "1"], {
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  children.push(tap);
  await waitFor(() => answers(tapPort), 10_000, "the tap");
  const endpoint = `ws://127.0.0.1:${tapPort}/devtools/browser/tap`;
  const world: World = { found, chromePort, tapPort, sitePort, endpoint, transcript, key: "", daemonPid: 0, daemons: [], children, site };
  const started = await addDaemon(world, session, credential);
  world.key = started.key;
  world.daemonPid = started.pid;
  return world;
}

export async function addDaemon(world: World, session: string, credential = CREDENTIAL): Promise<{ key: string; pid: number }> {
  const { found, endpoint } = world;
  const key = pluginSessionKey("", credential, session);
  const config: JsonObject = new Map<string, Value>([
    ["session", session], ["namespace", ""], ["key", key], ["data_root", found.data], ["ws", endpoint], ["port", null], ["data_dir", null],
    ["endpoint_label", null], ["idle_timeout_ms", null], ["debug", true], ["no_auto_dialog", false], ["pin_tab", null], ["plugin", credentialId(credential)],
  ]);
  const dir = browseDir(found.data);
  let daemonPid = 0;
  try {
    const spawned = spawnDaemon(dir, key, config, { kind: "ts", program: PROGRAM });
    daemonPid = spawned.child.pid as number;
    const socket = await awaitDaemon(dir, key, spawned, async () => (socketIsOurs(`${key}.sock`, dir) === null ? null : connectTo(path.join(found.browse, `${key}.sock`))));
    (socket as net.Socket).destroy();
  } finally {
    closeFd(dir);
  }
  world.daemons.push({ key, pid: daemonPid });
  return { key, pid: daemonPid };
}

export async function pageTarget(world: World): Promise<string> {
  const body = await (await fetch(`http://127.0.0.1:${world.chromePort}/json/list`)).json() as { id: string; type: string; url: string }[];
  const page = body.find((item) => item.type === "page" && item.url.includes("/form"));
  if (!page) throw new Error("no form page in Chrome");
  return page.id;
}

export type Asked = { exit: number; out: string; err: string; code?: string; loader?: string; metrics?: Record<string, unknown> };

export async function step(world: World, argv: string[], options: Record<string, unknown> = {}, credential: string | null = CREDENTIAL, key = world.key, name = argv.join(" ")): Promise<Asked> {
  await tap(world, "mark", { step: name, argv });
  try {
    return await asked(world, argv, options, credential, key);
  } finally {
    await tap(world, "done", { step: name });
    await tap(world, "unhold");
  }
}

async function asked(world: World, argv: string[], options: Record<string, unknown>, credential: string | null, key: string): Promise<Asked> {
  const request: Record<string, unknown> = { argv, options: { humanize: false, timeout_ms: 25000, ...options }, cwd: "/", env: {}, stdin: null };
  if (credential !== null) request["credential"] = credential;
  const { text } = await raw(path.join(world.found.browse, `${key}.sock`), `${JSON.stringify(request)}\n`, { timeoutMs: 60_000 });
  return JSON.parse(text) as Asked;
}

export async function tap(world: World, route: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${world.tapPort}/tap/${route}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return (await response.json()) as Record<string, unknown>;
}

export async function openTab(world: World, url = `http://127.0.0.1:${world.sitePort}/form`): Promise<string> {
  const tab = (await (await fetch(`http://127.0.0.1:${world.chromePort}/json/new?${url}`, { method: "PUT" })).json()) as { id: string };
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const list = (await (await fetch(`http://127.0.0.1:${world.chromePort}/json/list`)).json()) as { id: string; title: string }[];
    if (list.some((item) => item.id === tab.id && item.title === "Form page")) return tab.id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the new tab didn't load");
}

export async function resetPage(world: World, target: string, url = `http://127.0.0.1:${world.sitePort}/form`, settle = true): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${world.chromePort}/devtools/page/${target}`);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
    socket.onmessage = (event) => {
      if ((JSON.parse(String(event.data)) as { id?: number }).id === 1) resolve();
    };
    socket.onerror = () => reject(new Error("the harness couldn't reach the page to reset it"));
  });
  socket.close();
  if (!settle) return;
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const list = (await (await fetch(`http://127.0.0.1:${world.chromePort}/json/list`)).json()) as { id: string; url: string; title: string }[];
    if (list.some((item) => item.id === target && item.url === url && item.title === "Form page")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the page didn't reset");
}

export function entries(world: World): Entry[] {
  return fs.readFileSync(world.transcript, "utf8").split("\n").filter((line) => line).map((line) => JSON.parse(line) as Entry);
}

export async function stopWorld(world: World): Promise<void> {
  for (const daemon of world.daemons) {
    try {
      await step(world, ["close"], {}, CREDENTIAL, daemon.key);
    } catch {}
  }
  const deadline = performance.now() + 15_000;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const daemon of world.daemons) {
    while (alive(daemon.pid) && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (alive(daemon.pid)) process.kill(daemon.pid, "SIGTERM");
  }
  for (const child of world.children) {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {}
  }
  await new Promise<void>((resolve) => world.site.close(() => resolve()));
  if (!process.env["ARDIA_F1_KEEP"]) world.found.done();
}
