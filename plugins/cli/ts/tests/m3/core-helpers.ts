import { Cancelled } from "../../src/browse/cdp/cancel.ts";
import { CdpError, CdpTimeout } from "../../src/browse/daemon-errors.ts";
import { State } from "../../src/browse/state/state.ts";

export type Sent = { method: string; params: Record<string, unknown>; session: string | null };
export type Answer = Record<string, unknown> | Error | (() => Promise<Record<string, unknown>>);
export type Script = (method: string, params: Record<string, unknown>, session: string | null) => Answer | undefined;

export const MAIN = "FRAME-MAIN";
export const LOADER = "LOADER-1";

export function frameTree(main = MAIN, loader = LOADER, url = "http://127.0.0.1/page.html"): Record<string, unknown> {
  return { frameTree: { frame: { id: main, loaderId: loader, url, securityOrigin: "http://127.0.0.1", name: "" }, childFrames: [] } };
}

export class FakeBrowser {
  readonly sent: Sent[] = [];
  alive = true;
  closedByUs = false;
  inFlight = 0;
  peak = 0;
  attaches = 0;

  constructor(readonly script: Script = () => undefined) {}

  async send(method: string, params?: Record<string, unknown> | null, options: { session?: string | null; timeout?: number | null } = {}): Promise<Record<string, unknown>> {
    const given = params ?? {};
    const session = options.session ?? null;
    this.sent.push({ method, params: given, session });
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const scripted = this.script(method, given, session);
      const answer = scripted === undefined ? this.fallback(method, given) : scripted;
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return await answer();
      return answer;
    } finally {
      this.inFlight -= 1;
    }
  }

  fallback(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
    if (method === "Target.attachToTarget") {
      this.attaches += 1;
      return { sessionId: `SESSION-${this.attaches}` };
    }
    if (method === "Page.getFrameTree") return frameTree();
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.evaluate" && params["expression"] === "globalThis") return { result: { type: "object", className: "Window", objectId: "WORLD-HANDLE" } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 700 } };
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "TARGET", type: "page", url: "http://127.0.0.1/page.html", title: "Page" }] };
    if (method === "Runtime.callFunctionOn") return { result: { type: "string", value: "ok" } };
    return {};
  }

  methods(session: string | null | undefined = undefined): string[] {
    return this.sent.filter((entry) => session === undefined || entry.session === session).map((entry) => entry.method);
  }

  async close(): Promise<void> {
    this.closedByUs = true;
  }
}

export function cdpError(method: string, message: string): CdpError {
  return new CdpError(method, message);
}

export function timeout(method: string, seconds = 30): CdpTimeout {
  return new CdpTimeout(method, seconds);
}

export function cancelled(): Cancelled {
  return new Cancelled();
}

export function stateWith(browser: FakeBrowser, targets: string[] = ["TARGET"], explicit = true): State {
  const state = new State({ session: "s", key: "k", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  state.browser = browser as never;
  state.instance = "instance";
  state.endpoint = { ws: "ws://127.0.0.1:1/devtools/browser/x", source: "--port 1", explicit, active: null, instance: "instance" };
  state.targetInfos = new Map(targets.map((target) => [target, { targetId: target, type: "page", url: "http://127.0.0.1/page.html", title: "Page" }]));
  return state;
}
