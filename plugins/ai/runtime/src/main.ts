// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";
import { Channel, fdTransport, type Transport } from "./channel.ts";
import { ardiaHost, setArdiaHost, setPluginValues, type PluginValues } from "./host.ts";
import { installWorkspace } from "./workspace.ts";
import { pluginState } from "./state.ts";
import { noteCleanExit, noteRunStart, Telemetry } from "./telemetry.ts";
import { PageBridge } from "./pageBridge.ts";

const STARTUP_DEADLINE_MS = 90_000;
const TOKEN_WINDOW_MS = 12 * 60 * 60 * 1000;

export function bootstrapToken(secret: string, nowMs: number): string {
  return Crypto.createHmac("sha256", secret).update(`t3-desktop-bootstrap:${Math.floor(nowMs / TOKEN_WINDOW_MS)}`).digest("hex");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = Net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("No free port on 127.0.0.1."))));
    });
  });
}

function standaloneTransport(): Transport {
  return { write: (line) => process.stderr.write(`[ardia channel] ${line}\n`), onLine: () => undefined, onClose: () => undefined, close: () => undefined };
}

function dataDirOf(): string {
  const given = process.env.ARDIA_PLUGIN_DATA;
  if (given) return given;
  const tmp = process.env.TMPDIR;
  if (tmp) return Path.dirname(tmp.replace(/\/+$/, ""));
  return Path.join(process.cwd(), ".data");
}

function bootstrapFd(dataDir: string, envelope: Record<string, unknown>): number {
  const runDir = Path.join(dataDir, "run");
  Fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = Path.join(runDir, `bootstrap-${process.pid}.json`);
  Fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600, flag: "w" });
  const fd = Fs.openSync(file, "r");
  Fs.unlinkSync(file);
  return fd;
}

function providerPath(home: string): string {
  const dirs = [Path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const given = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...dirs, ...given])].join(":");
}

async function waitUntilServing(port: number): Promise<boolean> {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export async function runArdia(args: ReadonlyArray<string>) {
  const pluginDir = process.cwd();
  const dataDir = dataDirOf();
  const fdText = process.env.ARDIA_PLUGIN_FD;
  const channel = new Channel(fdText ? fdTransport(Number(fdText)) : standaloneTransport());
  const hello = fdText ? await channel.request<{ version?: string; values?: PluginValues }>("hello") : { version: "standalone", values: {} };
  channel.onClose(() => {
    noteCleanExit(dataDir);
    process.exit(0);
  });
  channel.onEvent((event) => {
    if (event.event === "plugin.values") setPluginValues((event.data.values ?? {}) as PluginValues);
  });
  channel.serveTools(async (call) => {
    if (call.tool !== "new-chat") throw new Error(`There's no tool ${call.tool}.`);
    const input = (call.input ?? {}) as { split?: unknown };
    const split = input.split === true;
    const side = ardiaHost()?.values.side === "left" ? "left" : "right";
    const opened = await channel.request<{ tabId: string }>("page.open", { path: `/${Crypto.randomUUID()}`, split, ...(split ? { side, context: true } : {}) });
    return { tab: opened.tabId };
  });
  if (fdText) void channel.request("subscribe", { events: ["tab.closed"] }).catch(() => undefined);

  const state = pluginState(dataDir);
  state.telemetry = new Telemetry(fdText ? channel : null);
  if (noteRunStart(dataDir)) state.telemetry.count("runtime_crashes");
  state.telemetry.count(hello.values?.mode === "ai" ? "mode_ai_first" : "mode_browser_first");
  const finish = () => {
    noteCleanExit(dataDir);
    void state.telemetry.flush().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once("SIGTERM", finish);
  process.once("SIGINT", finish);
  const t3Home = Path.join(dataDir, "t3");
  const workspaceDir = Path.join(dataDir, "workspace");
  installWorkspace(pluginDir, workspaceDir);

  const secret = Crypto.randomBytes(32).toString("base64url");
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : await freePort();
  const fd = bootstrapFd(dataDir, {
    mode: "desktop",
    noBrowser: true,
    port,
    host: "127.0.0.1",
    t3Home,
    desktopBootstrapToken: Crypto.randomBytes(32).toString("base64url"),
    desktopBootstrapSecret: secret,
    shellEnvironmentPrepared: true,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopAppUpdate: false,
  });

  setArdiaHost({ channel, pluginDir, dataDir, workspaceDir, port, values: hello.values ?? {}, appVersion: hello.version ?? "" });
  process.env.PATH = providerPath(process.env.HOME ?? "");
  process.env.T3CODE_HOME = t3Home;
  process.env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = "true";
  process.chdir(workspaceDir);
  process.argv = [process.argv[0]!, process.argv[1]!, "serve", "--bootstrap-fd", String(fd), "--base-dir", t3Home];

  void waitUntilServing(port).then(async (up) => {
    if (!up) {
      process.stderr.write("The runtime didn't start serving in time.\n");
      process.exit(1);
    }
    if (!fdText) {
      process.stdout.write(`ardia page: http://127.0.0.1:${port}/#k=${bootstrapToken(secret, Date.now())}\n`);
      return;
    }
    const handle = ardiaHost()!;
    const { answerPageApi } = await import("./routes.ts");
    const { selfClient } = await import("./selfClient.ts");
    const bridge = new PageBridge({
      rpc: selfClient(port, () => bootstrapToken(secret, Date.now())),
      api: (method, path, body, signal) => answerPageApi(handle, method, path, body, signal),
      open: async (url) => void (await channel.request("open", { urls: [url] })),
      post: (message, view) => channel.postToPage(message, view),
    });
    channel.onPageMessage((message, view) => bridge.receive(message, view));
    channel.onClose(() => bridge.close());
  });

  const { runCli } = await import("../binCli.ts");
  runCli();
}
