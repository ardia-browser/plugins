import { formatG } from "../../pylib/format.ts";
import {
  BrowseError,
  CdpError,
  CdpTimeout,
  ConnectionLost,
  Gated,
  OutcomeUnknown,
  POLICY_REFUSAL,
  refusalReason,
  Unreachable,
} from "../daemon-errors.ts";
import { clock, cdpCall } from "../metrics.ts";
import { Cancelled, checkCancelled, currentSignal, later } from "./cancel.ts";
import { ATTACH_METHODS } from "./guard.ts";
import { CdpLink, CommandFailed, CommandTimeout, ConnectionLost as LinkLost, type EventCallback, isObject, linkLog, OpenFailed, timerMs } from "./link.ts";
import { pyText, pyTruthy } from "./pyvalue.ts";

export const MAX_MESSAGE = 256 * 1024 * 1024;
export const CONNECT_TIMEOUT = 10;
export const ATTACH_WAIT = 30;
export const DETACH_WAIT = 10;
export const MAX_LATE_ATTACHES = 16;
export const EVENTS: readonly string[] = [
  "Target.targetCreated",
  "Target.targetDestroyed",
  "Target.targetInfoChanged",
  "Target.detachedFromTarget",
  "Target.attachedToTarget",
  "Inspector.detached",
  "Inspector.targetCrashed",
  "Inspector.targetReloadedAfterCrash",
  "Page.lifecycleEvent",
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.frameDetached",
  "Page.screencastFrame",
  "Input.dragIntercepted",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Runtime.executionContextsCleared",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Network.dataReceived",
  "Fetch.requestPaused",
  "Fetch.authRequired",
  "Tracing.dataCollected",
  "Tracing.tracingComplete",
  "Browser.downloadWillBegin",
  "Browser.downloadProgress",
];

export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "Page.navigate",
  "Page.reload",
  "Page.handleJavaScriptDialog",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.bringToFront",
  "DOM.setFileInputFiles",
  "DOM.focus",
  "Network.setCookie",
  "Network.setCookies",
  "Network.clearBrowserCookies",
  "Network.setExtraHTTPHeaders",
  "Network.emulateNetworkConditions",
  "Fetch.fulfillRequest",
  "Fetch.failRequest",
  "Fetch.continueRequest",
  "Fetch.continueWithAuth",
  "Overlay.highlightNode",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.activateTarget",
  "Browser.setDownloadBehavior",
  "Browser.grantPermissions",
]);

export type CdpResult = Record<string, unknown>;
export type Endpoint = { readonly ws: string; readonly instance?: string | null };
export type SendOptions = {
  session?: string | null;
  timeout?: number | null;
  mutation?: boolean;
  signal?: AbortSignal | null;
};

const sendReserved = Symbol("sendReserved");

export function isMutation(method: string): boolean {
  return MUTATING_METHODS.has(method) || method.startsWith("Input.") || method.startsWith("Emulation.");
}

export function failure(method: string, error: CommandFailed): BrowseError {
  const detail = pyTruthy(error.detail) ? pyText(error.detail) : "The browser rejected the command";
  const text = `${method}: ${detail} (code ${pyText(error.code)})`;
  if (text.includes(POLICY_REFUSAL)) return new Gated(method, null, null, refusalReason(text, method));
  return new CdpError(method, detail, null, error.code);
}

export class Browser {
  link: CdpLink | null = null;
  closedByUs = false;

  constructor(
    readonly endpoint: Endpoint,
    readonly onEvent: EventCallback,
    readonly unreachable: (error: unknown) => string = (error) => (error instanceof Error && error.message) || "can't connect",
  ) {}

  get instance(): string | null {
    return this.endpoint.instance ?? null;
  }

  get alive(): boolean {
    return this.link !== null && !this.link.lost;
  }

  private opening: Promise<void> | null = null;

  open(signal: AbortSignal | null = currentSignal()): Promise<void> {
    if (this.opening !== null) return this.opening;
    if (this.link?.connected) return Promise.reject(new ConnectionLost());
    const link = new CdpLink(this.endpoint.ws, MAX_MESSAGE);
    this.link = link;
    const opening = this.connect(link, signal).finally(() => {
      this.opening = null;
    });
    this.opening = opening;
    return opening;
  }

  private async connect(link: CdpLink, signal: AbortSignal | null): Promise<void> {
    try {
      await link.open(CONNECT_TIMEOUT, signal);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      if (error instanceof LinkLost) throw new ConnectionLost();
      const safe = error instanceof OpenFailed ? error : new OpenFailed("ConnectionError", "the WebSocket connection failed");
      safe.endpoint = link.endpoint;
      throw new Unreachable(this.unreachable(safe));
    }
    for (const name of EVENTS) link.on(name, (method, params, session) => this.event(method, params, session));
  }

  async send(method: string, params?: CdpResult | null, options: SendOptions = {}): Promise<CdpResult> {
    if (ATTACH_METHODS.has(method)) {
      const timeout = options.timeout === undefined ? 30 : options.timeout;
      return claimedAttach(this, method, params, {
        wait: timeout === null ? Number.POSITIVE_INFINITY : timeout,
        session: options.session ?? null,
        unknown: options.mutation ?? false,
        signal: options.signal === undefined ? currentSignal() : options.signal,
      });
    }
    return this[sendReserved](method, params, options);
  }

  async [sendReserved](method: string, params: CdpResult | null | undefined, options: SendOptions, ident?: number): Promise<CdpResult> {
    const link = this.link;
    if (link === null || link.lost) throw new ConnectionLost();
    const command: Record<string, unknown> = { method, params: params ?? {} };
    if (options.session) command["sessionId"] = options.session;
    const timeout = options.timeout === undefined ? 30 : options.timeout;
    const started = clock();
    let response: Record<string, unknown>;
    try {
      response = await link.execute(command, timeout, ident, options.signal === undefined ? currentSignal() : options.signal);
    } catch (error) {
      if (error instanceof CommandFailed) throw failure(method, error);
      if (error instanceof CommandTimeout) {
        if (options.mutation || isMutation(method)) {
          throw new OutcomeUnknown(`\`${method}\``, `Ardia didn't answer ${method} in ${formatG(timeout as number)}s after it was sent`);
        }
        throw new CdpTimeout(method, timeout as number);
      }
      if (error instanceof LinkLost) throw new ConnectionLost();
      throw error;
    }
    cdpCall(started);
    const result = response["result"];
    return (pyTruthy(result) ? result : {}) as CdpResult;
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.link === null) return;
    try {
      await this.link.close();
    } catch (error) {
      linkLog.problem("closing the browser connection failed", error);
    }
  }

  private event(method: string, params: unknown, session: unknown): void {
    try {
      this.onEvent(method, params, session);
    } catch (error) {
      linkLog.problem("event handler failed", error);
    }
  }
}

export function detachUnclaimed(browser: Browser, result: unknown, session: string | null): void {
  if (!isObject(result)) return;
  const child = result["sessionId"];
  if (!pyTruthy(child)) return;
  browser.send("Target.detachFromTarget", { sessionId: child }, { session, timeout: DETACH_WAIT, signal: null }).catch(() => {});
}

export type AttachOptions = { wait?: number | null; session?: string | null; unknown?: boolean; signal?: AbortSignal | null };

export async function claimedAttach(browser: Browser, method: string, params?: CdpResult | null, options: AttachOptions = {}): Promise<CdpResult> {
  const wait = options.wait ?? ATTACH_WAIT;
  const session = options.session ?? null;
  const signal = options.signal === undefined ? currentSignal() : options.signal;
  checkCancelled(signal);
  const link = browser.link;
  let attaching: Promise<CdpResult>;
  if (link === null) {
    attaching = browser[sendReserved](method, params, { session, timeout: null, signal: null });
  } else {
    const ident = link.reserveAttach(MAX_LATE_ATTACHES);
    if (ident === null) {
      throw new BrowseError(
        `${method} wasn't sent: ${link.attaching.size} DevTools attaches on this connection haven't been answered. Try again ` +
          "once Ardia catches up, or `ardia browse close` this session to start its connection over",
        null,
        "attaches_unanswered",
      );
    }
    attaching = browser[sendReserved](method, params, { session, timeout: null, signal: null }, ident);
    attaching.then(
      () => link.attaching.delete(ident),
      () => link.attaching.delete(ident),
    );
  }
  type Outcome = { kind: "answered"; result: CdpResult } | { kind: "failed"; error: unknown } | { kind: "late"; error: Error };
  let stopTimer = () => {};
  let stopListening = () => {};
  const outcome = await new Promise<Outcome>((resolve) => {
    attaching.then(
      (result) => resolve({ kind: "answered", result }),
      (error: unknown) => resolve({ kind: "failed", error }),
    );
    const ms = timerMs(wait);
    if (ms !== null) {
      stopTimer = later(ms, () =>
        resolve({
          kind: "late",
          error: options.unknown
            ? new OutcomeUnknown(`\`${method}\``, `Ardia didn't answer ${method} in ${formatG(wait)}s after it was sent`)
            : new CdpTimeout(method, wait),
        }),
      );
    }
    if (signal !== null) {
      const stop = () => resolve({ kind: "late", error: new Cancelled() });
      signal.addEventListener("abort", stop, { once: true });
      stopListening = () => signal.removeEventListener("abort", stop);
    }
  });
  stopTimer();
  stopListening();
  if (outcome.kind === "answered") return outcome.result;
  if (outcome.kind === "failed") throw outcome.error;
  attaching.then(
    (result) => detachUnclaimed(browser, result, session),
    () => {},
  );
  throw outcome.error;
}
