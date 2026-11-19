import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string; code: number }; sessionId?: string };

export class CdpError extends Error {
  constructor(readonly method: string, readonly detail: string) {
    super(`${method}: ${detail}`);
  }
}

export class Cdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>();
  private listeners = new Set<(message: Message) => void>();
  readonly log: { method: string; sessionId?: string }[] = [];

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", event => {
      const message: Message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!waiter) return;
        if (message.error) waiter.reject(new CdpError(waiter.method, message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of [...this.listeners]) listener(message);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new CdpError(waiter.method, "connection closed"));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 20000): Promise<T> {
    const id = ++this.nextId;
    this.log.push({ method, sessionId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, `timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  fire(method: string, params: object = {}, sessionId?: string) {
    this.send(method, params, sessionId).catch(() => {});
  }

  on(listener: (message: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(predicate: (message: Message) => boolean, timeoutMs: number, what: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)); }, timeoutMs);
      const off = this.on(message => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        off();
        resolve(message);
      });
    });
  }

  close() {
    this.socket.close();
  }
}

export type Launch = { cdp: Cdp; browserWs: string; profile: string; child?: ChildProcess; headless: boolean; flags: string[] };

export async function launchBrowser(app: string, options: { headless: boolean; extraFlags?: string[]; scratch: string }): Promise<Launch> {
  const profile = mkdtempSync(join(options.scratch, "profile-"));
  const port = await freePort();
  const flags = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--password-store=basic",
    "--use-mock-keychain",
    "--use-fake-device-for-media-stream",
    "--window-size=1100,900",
    ...(options.headless ? ["--headless=new"] : ["--window-position=40,40"]),
    ...(options.extraFlags ?? []),
    "about:blank",
  ];
  let child: ChildProcess | undefined;
  if (options.headless) {
    const binary = join(app, "Contents/MacOS", app.split("/").pop()!.replace(/\.app$/, ""));
    child = spawn(binary, flags, { stdio: "ignore" });
  } else {
    const opener = spawn("open", ["-g", "-n", "-a", app, "--args", ...flags], { stdio: "ignore" });
    await new Promise(resolve => opener.on("exit", resolve));
  }
  const deadline = Date.now() + 30000;
  let browserWs = "";
  while (!browserWs) {
    if (Date.now() > deadline) throw new Error(`browser did not answer on port ${port} within 30s`);
    if (child && child.exitCode !== null) throw new Error(`browser exited with ${child.exitCode}`);
    browserWs = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json()).then((info: any) => info.webSocketDebuggerUrl ?? "", () => "");
    if (!browserWs) await Bun.sleep(100);
  }
  const cdp = await Cdp.connect(browserWs);
  return { cdp, browserWs, profile, child, headless: options.headless, flags };
}

export async function quitBrowser(launch: Launch) {
  await launch.cdp.send("Browser.close", {}, undefined, 5000).catch(() => {});
  launch.cdp.close();
  if (launch.child && launch.child.exitCode === null) {
    const exited = new Promise(resolve => launch.child!.once("exit", resolve));
    await Promise.race([exited, Bun.sleep(5000)]);
    if (launch.child.exitCode === null) launch.child.kill("SIGKILL");
  } else {
    await Bun.sleep(1500);
  }
  rmSync(launch.profile, { recursive: true, force: true });
}

async function freePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

export function scratchDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}
