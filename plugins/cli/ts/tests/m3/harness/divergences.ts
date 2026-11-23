import { readFileSync } from "node:fs";
import type { Message } from "../canon.ts";
import { load, type Rewrite } from "./normalize.ts";
import { BROWSE_LIBRARY } from "./paths.ts";

export type Divergence = { row: number | null; always?: boolean; decision?: string; commands: string; python: string; ts: string; why: string };

export const DIVERGENCES: Record<string, Divergence> = {
  "world-handle": {
    row: 8,
    always: true,
    commands: "every isolated-world page call",
    python: 'Runtime.callFunctionOn {"executionContextId": <world>, ...}',
    ts: 'Runtime.evaluate {"expression": "globalThis", "contextId": <world>, "returnByValue": false} once per world, then Page.getFrameTree on the same session to bind the handle to the loader it reports, then Runtime.callFunctionOn {"objectId": <that handle>, ...}',
    why: "a numeric context id can be reused across renderer processes; the handle's object id is refused by the renderer once its document is gone, so a call never runs in a document it wasn't meant for",
  },
  "busy-probe-isolated": {
    row: 8,
    commands: "any command on a tab whose page stopped answering in the last 120 s (the busy probe before it)",
    python: 'Runtime.evaluate {"expression": "1", "returnByValue": true} on the page session, in the page\'s main world',
    ts: 'Runtime.evaluate {"expression": "1", "contextId": <the ardia-browse world>, "returnByValue": true}, with Page.createIsolatedWorld first when that world isn\'t known for the current document',
    why: "a main-world evaluation is visible to the page (ardia#2812 row 8); the isolated world shares the document but not its JS",
  },
  "oopif-auto-attach": {
    row: 13,
    always: true,
    commands: "every page session the TS daemon attaches",
    python: "nothing: Python never sees out-of-process iframes",
    ts: 'Target.setAutoAttach {"autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true, "filter": iframes only} on the page session after Page.setLifecycleEventsEnabled, and on each iframe session it attaches; replay answers it with an empty result',
    why: "reads and snapshots reach out-of-process iframes in their own sessions (ardia#2812 rows 13, 21)",
  },
  "temp-tab-marker": {
    row: null,
    always: true,
    decision: "D2 round 3 (plugins#20): temporary tabs open at about:blank#ardia-temp-<nonce> so a later sweep finds lost ones",
    commands: "read <url>... (temporary reader tabs)",
    python: 'Target.createTarget {"url": "about:blank", "background": true} for a reader tab',
    ts: 'Target.createTarget {"url": "about:blank#ardia-temp-<nonce>", "background": true}',
    why: "a temporary tab lost at shutdown is closed by the next sweep only if it is marked (docs/cli.md accepted differences)",
  },
  "shadow-pierce": {
    row: 12,
    always: true,
    commands: "a selector that matches nothing in the document (get, is, snapshot -s, read -s, get count)",
    python: "nothing: the command fails with not_found",
    ts: 'Runtime.callFunctionOn "() => document" in the isolated world, DOM.describeNode {"objectId": <it>, "depth": -1, "pierce": true}, then each open or closed shadow root resolved into the isolated world and searched; replay answers the first with null',
    why: "selectors reach elements inside closed shadow roots (ardia#2812 row 12)",
  },
  "console-detectable": {
    row: 8,
    commands: "console, the first time it starts capture on a tab",
    python: "answer text: ... (Runtime is on for this tab until the session ends)",
    ts: "answer text: ... (Runtime is on for this tab until the session ends; the page can detect this)",
    why: "console capture is the one Runtime.enable on a page session and a page can detect it; the notice says so (normalize rule `console-detectable`)",
  },
  "eval-isolated": {
    row: 9,
    commands: "eval --isolated, wait --fn --isolated and clipboard read (eval and wait --fn run in the main world by default, as Python does)",
    python: 'Runtime.evaluate {"expression": <script>, "returnByValue": true, "awaitPromise": true, "userGesture": false} on the page session, in the page\'s main world',
    ts: 'Runtime.callFunctionOn {"functionDeclaration": "function (source) { return (0, eval)(source); }", "objectId": <the ardia-browse world>, "arguments": [{"value": <script>}], "returnByValue": true, "awaitPromise": true, "userGesture": false}',
    why: "a main-world evaluation leaves globals and stack frames the page can see (ardia#2812 rows 8 and 9); the isolated world shares the document but not its JavaScript. `--isolated` opts in; clipboard read always uses it",
  },
  "script-isolated": {
    row: 9,
    commands: "script (its controller in the temporary tab)",
    python: 'Runtime.evaluate {"expression": <CONTROLLER>, "returnByValue": false, "awaitPromise": true} in the controller tab\'s main world',
    ts: 'Page.createIsolatedWorld and the library in the controller tab, then Runtime.callFunctionOn {"functionDeclaration": "function () { return (<CONTROLLER>); }", "objectId": <the ardia-browse world>, "arguments": [], "returnByValue": false, "awaitPromise": true}; the worker and every later controller call are the same. In this scenario Page.createIsolatedWorld and the library evaluation aren\'t compared on either side (core/* compares them)',
    why: "the controller's global and its worker live in the isolated world, so nothing the script machinery defines is visible to a page (ardia#2812 row 9)",
  },
  "permission-overrides": {
    row: 3,
    commands: "clipboard read|write, set permission",
    python: 'Browser.grantPermissions {"origin": <origin>, "permissions": ["clipboardReadWrite", "clipboardSanitizedWrite"]}',
    ts: 'Browser.setPermission {"permission": {"name": <one>}, "setting": "granted", "origin": <origin>} for each permission',
    why: "grantPermissions replaces every override the origin had, so a clipboard grant revoked a granted geolocation; per-permission overrides compose. Neither form is compared in a scenario that names this; human_d7 rows 3 and 14 prove the grants",
  },
  "json-error-code": {
    row: null,
    decision: "docs/cli.md, the `--json` error code table: every failing `--json` answer carries a `code`, `command_failed` (or `unknown_command`) for a daemon error line without one",
    commands: "any command run with --json whose daemon answer is an error line without a code",
    python: 'stdout: {"success":false,"data":null,"error":"No dialog is currently open"} (Python\'s client printed the daemon\'s line)',
    ts: 'stdout: {"success":false,"data":null,"error":"No dialog is currently open","code":"command_failed"}',
    why: "an agent reading --json output can branch on the code of every failure; compared through the normalize rule `json-error-code`, never as a request rewrite",
  },
  "error-remedy": {
    row: null,
    decision: "docs/cli.md, errors: every failure ends with its `(code)` and, when one command fixes it, a `  remedy: <command>` line (`\"remedy\"` in --json), from src/browse/remedies.ts",
    commands: "any command that fails with a code",
    python: "stderr: ✗ Usage: ardia browse pushstate <url>",
    ts: "stderr: ✗ Usage: ardia browse pushstate <url> (usage)\\n  remedy: ardia browse pushstate --help",
    why: "an agent sees the stable code and the next command to run without looking either up; compared through the normalize rule `error-remedy`, never as a request rewrite",
  },
  "open-moved-tab": {
    row: null,
    decision: "docs/cli.md, `tab active`: in the TypeScript CLI the answer's first line says open made its own background tab and left the picked tab unchanged",
    commands: "open <url> on a session that took the user's tab with `tab active`",
    python: "answer text: ✓ <title>\\n  <url>\\n→ [t3] is this session's tab now, a background tab of its own, since this session uses your tab [t2] and won't navigate it; `tab t2` goes back; it takes input without being shown",
    ts: "answer text: → Opened in a new background tab [t3]; the tab you picked with `tab active` [t2] is unchanged (`open --here <url>` navigates it, `tab t2` goes back)\\n✓ <title>\\n  <url>",
    why: "the agent sees first that its open didn't touch the user's tab, and how to navigate it (`open --here`); compared through the normalize rule `open-moved-tab`, never as a request rewrite",
  },
  "editing-commands": {
    row: 20,
    commands: "press, keydown and fill's select-all: a shortcut with Control, Meta or Alt",
    python: 'Input.dispatchKeyEvent with "commands" for Control or Meta with a, z, y and Shift+z, on every platform',
    ts: 'Input.dispatchKeyEvent with Python\'s "commands" for Control or Meta with a, z, y and Shift+z on every platform, and on macOS also the rest of its editing shortcuts (Meta with c, x, v; Meta and Alt with the arrows, Backspace and Delete)',
    why: "on macOS a native contenteditable ignores Meta+c, Meta+x and the rest without the editing command (ardia#2812 row 20); 0.4.0's Control/Meta select-all, undo and redo are kept everywhere for compatibility",
  },
};

const TEMP_MARKER = "about:blank#ardia-temp-";
const PIERCE_DOCUMENT = "() => document";
const ISOLATED_EVAL = "function (source) { return (0, eval)(source); }";
const SCRIPT_CONTROLLER_HEAD = "\n(() => {\n  if (globalThis.__ardiaScript) return globalThis.__ardiaScript;";
const UNANSWERING_FAULTS = ["drop", "stop"];
const MAC_SHORTCUT_KEYS = ["a", "c", "x", "v", "z"];
const META = 4;
const PAGE_SESSION_ENABLES = ["Runtime.enable", "Debugger.enable", "Console.enable"];
const CONSOLE_CAPTURE = ["console", "errors"];
const BUSY_PROBE = "1";
const WORLD_HANDLE = "globalThis";

type Params = Record<string, unknown>;
type ScenarioLike = { divergences?: unknown; steps?: unknown };

let library: string | undefined;

export function browseLibrary(): string {
  library ??= readFileSync(BROWSE_LIBRARY, "utf8");
  return library;
}

export function daemonOf(impl: string): string {
  return impl.split(":").at(-1) as string;
}

function paramsOf(message: Message): Params {
  const params = message.params;
  return params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Params) : {};
}

function busyProbe(message: Message): boolean {
  return message.method === "Runtime.evaluate" && paramsOf(message)["expression"] === BUSY_PROBE;
}

function mainWorldEval(message: Message): boolean {
  const params = paramsOf(message);
  return message.method === "Runtime.evaluate" && !("contextId" in params) && params["userGesture"] === false && params["returnByValue"] === true && params["awaitPromise"] === true;
}

export function namesFor(scenario: ScenarioLike, faultKind?: string): string[] {
  const names = Object.entries(DIVERGENCES).filter(([, entry]) => entry.always).map(([name]) => name);
  const asked = Array.isArray(scenario.divergences) ? (scenario.divergences as string[]) : [];
  for (const name of asked) {
    if (!(name in DIVERGENCES)) throw new Error(`unknown divergence: ${name}`);
    if (!names.includes(name)) names.push(name);
  }
  if (faultKind !== undefined && UNANSWERING_FAULTS.includes(faultKind) && !names.includes("busy-probe-isolated")) names.push("busy-probe-isolated");
  return names;
}

export class Rewriter implements Rewrite {
  private readonly binding = new Set<string>();
  private readonly handleRequests = new Set<string>();
  private readonly handles = new Set<string>();
  private readonly names: Set<string>;

  constructor(names: string[]) {
    const unknown = names.filter((name) => !(name in DIVERGENCES));
    if (unknown.length > 0) throw new Error(`unknown divergence(s): ${unknown.join(", ")}`);
    this.names = new Set(names);
  }

  reply(key: string, message: Message): void {
    if (!this.handleRequests.has(key)) return;
    this.handleRequests.delete(key);
    const result = (message.result ?? {}) as { result?: { objectId?: unknown } };
    const handle = result.result?.objectId;
    if (typeof handle === "string") this.handles.add(handle);
  }

  rewrite(message: Message, key: string): Message | null {
    const params = paramsOf(message);
    const method = message.method;
    const session = message.sessionId || "";
    if (this.names.has("world-handle")) {
      if (method === "Runtime.evaluate" && params["expression"] === WORLD_HANDLE && params["returnByValue"] === false) {
        this.binding.add(session);
        this.handleRequests.add(key);
        return null;
      }
      if (this.binding.has(session)) {
        this.binding.delete(session);
        if (method === "Page.getFrameTree") return null;
      }
      if (method === "Runtime.callFunctionOn") {
        const kept = Object.fromEntries(Object.entries(params).filter(([name, value]) => name !== "executionContextId" && !(name === "objectId" && typeof value === "string" && this.handles.has(value))));
        message = { ...message, params: kept };
      }
    }
    const current = paramsOf(message);
    if (this.names.has("oopif-auto-attach") && method === "Target.setAutoAttach") return null;
    if (this.names.has("shadow-pierce") && method === "DOM.describeNode" && params["pierce"] === true) return null;
    if (this.names.has("shadow-pierce") && method === "Runtime.callFunctionOn" && params["functionDeclaration"] === PIERCE_DOCUMENT) return null;
    if (this.names.has("temp-tab-marker") && method === "Target.createTarget" && String(params["url"] ?? "").startsWith(TEMP_MARKER)) {
      message = { ...message, params: { ...current, url: "about:blank" } };
    }
    if (this.names.has("editing-commands") && method === "Input.dispatchKeyEvent" && "commands" in params) {
      message = { ...message, params: Object.fromEntries(Object.entries(paramsOf(message)).filter(([name]) => name !== "commands")) };
    }
    if (this.names.has("eval-isolated") && mainWorldEval(message)) {
      message = { ...message, method: "Runtime.callFunctionOn", params: { functionDeclaration: ISOLATED_EVAL, arguments: [{ value: params["expression"] ?? null }], returnByValue: true, awaitPromise: true, userGesture: false } };
    }
    if (this.names.has("script-isolated")) {
      if (method === "Page.createIsolatedWorld" || (method === "Runtime.evaluate" && params["expression"] === browseLibrary())) return null;
      if (method === "Runtime.evaluate" && String(params["expression"] || "").startsWith(SCRIPT_CONTROLLER_HEAD)) {
        message = { ...message, method: "Runtime.callFunctionOn", params: { functionDeclaration: `function () { return (${params["expression"]}); }`, arguments: [], returnByValue: false, awaitPromise: true } };
      }
    }
    if (this.names.has("permission-overrides") && (method === "Browser.grantPermissions" || method === "Browser.setPermission")) return null;
    if (this.names.has("busy-probe-isolated") && busyProbe(message)) {
      message = { ...message, params: Object.fromEntries(Object.entries(params).filter(([name]) => name !== "contextId")) };
    }
    return message;
  }
}

export function rewriter(names: string[]): Rewriter {
  return new Rewriter(names);
}

export function capturesConsole(steps: unknown): boolean {
  for (const step of Array.isArray(steps) ? steps : []) {
    const argv = (Array.isArray((step as { argv?: unknown }).argv) ? ((step as { argv: unknown[] }).argv) : []).map(String);
    if ((argv.length > 0 && CONSOLE_CAPTURE.includes(argv[0] as string)) || argv.includes("--capture-console")) return true;
  }
  return false;
}

export function checks(transcriptPath: string, consoleCapture = false): string[] {
  const found = new Set<string>();
  const worlds = new Set<string>();
  const binding = new Set<string>();
  let touchEmulated = false;
  for (const entry of load(transcriptPath)) {
    if (entry.k !== "out") continue;
    let message: Message;
    try {
      message = JSON.parse(entry.m ?? "") as Message;
    } catch {
      continue;
    }
    if (message === null || typeof message !== "object" || !message.sessionId) continue;
    const method = message.method;
    const session = message.sessionId;
    const params = paramsOf(message);
    if (method !== undefined && PAGE_SESSION_ENABLES.includes(method) && !(consoleCapture && method === "Runtime.enable")) found.add(`row 8: ${method} sent on a page session`);
    if (method === "Page.createIsolatedWorld") worlds.add(session);
    if (binding.has(session)) {
      binding.delete(session);
      if (method !== "Page.getFrameTree") found.add("a world handle was used before its loader was checked by Page.getFrameTree");
    }
    if (method === "Runtime.evaluate" && params["expression"] === WORLD_HANDLE && params["returnByValue"] === false) binding.add(session);
    if (busyProbe(message) && !("contextId" in params) && worlds.has(session)) found.add("row 8: the busy probe ran in the page's main world though the page had an isolated world");
    if (method === "Runtime.callFunctionOn" && "executionContextId" in params) found.add("a page call named a numeric execution context instead of its world handle");
    const modifiers = Number(params["modifiers"] || 0);
    if (process.platform === "darwin" && method === "Input.dispatchKeyEvent" && (params["type"] === "keyDown" || params["type"] === "rawKeyDown") && modifiers & META
      && MAC_SHORTCUT_KEYS.includes(String(params["key"] ?? "").toLowerCase()) && !params["commands"]) {
      found.add(`row 20: Meta+${params["key"]} sent without its editing command`);
    }
    if (method === "Input.dispatchTouchEvent" && !touchEmulated) found.add("row 1: a touch event was sent without touch emulation");
    if (method === "Emulation.setTouchEmulationEnabled") touchEmulated = Boolean(params["enabled"]);
    if (method === "Runtime.callFunctionOn" && String(params["functionDeclaration"] ?? "").includes("navigator.maxTouchPoints")) touchEmulated = true;
  }
  return [...found].sort();
}
