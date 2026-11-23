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
import { ATTACH_METHODS, ForbiddenCommand } from "./guard.ts";
import { CdpLink, CommandFailed, CommandTimeout, ConnectionLost as LinkLost, type EventCallback, isObject, OpenFailed, report, timerMs } from "./link.ts";
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

type TakenOptions = { session: string | null; timeout: number | null; mutation: boolean; signal: AbortSignal | null };

function readOptions(options: SendOptions): TakenOptions {
  const { session, timeout, mutation, signal } = options;
  return {
    session: session ?? null,
    timeout: timeout === undefined ? 30 : timeout,
    mutation: mutation ?? false,
    signal: signal === undefined ? currentSignal() : signal,
  };
}

export function isMutation(method: string): boolean {
  return MUTATING_METHODS.has(method) || method.startsWith("Input.") || method.startsWith("Emulation.");
}

export function engineRefused(method: string, detail: unknown, code: unknown): boolean {
  if ((code !== -32601 && code !== -32000) || typeof detail !== "string") return false;
  const lead = `ardia: ${method}`;
  return detail.startsWith(lead) && detail.endsWith(POLICY_REFUSAL) && detail.slice(lead.length, lead.length + 1) === " ";
}

export function failure(method: string, error: CommandFailed): BrowseError {
  const detail = pyTruthy(error.detail) ? pyText(error.detail) : "The browser rejected the command";
  const text = `${method}: ${detail} (code ${pyText(error.code)})`;
  if (engineRefused(method, error.detail, error.code)) return new Gated(method, null, null, refusalReason(text, method));
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

  private state: "idle" | "connecting" | "open" | "closed" = "idle";
  private opening: Promise<void> | null = null;
  private attempt = 0;

  open(signal: AbortSignal | null = currentSignal()): Promise<void> {
    if (this.state === "connecting" && this.opening !== null) return this.opening;
    if (this.state === "closed" || this.link?.connected) return Promise.reject(new ConnectionLost());
    this.attempt += 1;
    const attempt = this.attempt;
    const link = new CdpLink(this.endpoint.ws, MAX_MESSAGE);
    this.link = link;
    this.state = "connecting";
    const opening = this.connect(link, attempt, signal);
    this.opening = opening;
    return opening;
  }

  private async connect(link: CdpLink, attempt: number, signal: AbortSignal | null): Promise<void> {
    let failure: unknown = null;
    try {
      await link.open(CONNECT_TIMEOUT, signal);
    } catch (error) {
      failure = error;
    }
    const current = attempt === this.attempt;
    if (current) this.opening = null;
    if (failure !== null) {
      if (current && this.state === "connecting") this.state = "idle";
      if (failure instanceof Cancelled) throw failure;
      if (failure instanceof LinkLost) throw new ConnectionLost();
      const safe = failure instanceof OpenFailed ? failure : new OpenFailed("ConnectionError", "the WebSocket connection failed");
      safe.endpoint = link.endpoint;
      throw new Unreachable(this.unreachable(safe));
    }
    if (!current || this.state !== "connecting") {
      await link.close();
      throw new ConnectionLost();
    }
    this.state = "open";
    for (const name of EVENTS) link.on(name, (method, params, session) => this.event(method, params, session));
  }

  async send(method: string, params?: CdpResult | null, options: SendOptions = {}): Promise<CdpResult> {
    const taken = readOptions(options);
    if (typeof method !== "string") throw new ForbiddenCommand("a CDP command's method must be a string");
    if (ATTACH_METHODS.has(method)) {
      return claimedAttach(this, method, params, {
        wait: taken.timeout === null ? Number.POSITIVE_INFINITY : taken.timeout,
        session: taken.session,
        unknown: taken.mutation,
        signal: taken.signal,
      });
    }
    return this[sendReserved](method, params, taken);
  }

  async [sendReserved](method: string, params: CdpResult | null | undefined, options: SendOptions, ident?: number): Promise<CdpResult> {
    const { session, timeout, mutation, signal } = readOptions(options);
    const link = this.link;
    if (link === null || link.lost) {
      if (ident !== undefined) link?.attaching.delete(ident);
      throw new ConnectionLost();
    }
    const command: Record<string, unknown> = { method, params: params ?? {} };
    if (session) command["sessionId"] = session;
    const started = clock();
    let response: Record<string, unknown>;
    try {
      response = await link.execute(command, timeout, ident, signal);
    } catch (error) {
      if (error instanceof CommandFailed) throw failure(method, error);
      if (error instanceof CommandTimeout) {
        if (error.sent && (mutation || isMutation(method))) {
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
    this.state = "closed";
    if (this.link === null) return;
    try {
      await this.link.close();
    } catch (error) {
      report("closing the browser connection failed", error);
    }
  }

  private event(method: string, params: unknown, session: unknown): void {
    try {
      this.onEvent(method, params, session);
    } catch (error) {
      report("event handler failed", error);
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
  const given = { wait: options.wait, session: options.session, unknown: options.unknown, signal: options.signal };
  const wait = given.wait ?? ATTACH_WAIT;
  const session = given.session ?? null;
  const unknown = given.unknown ?? false;
  const signal = given.signal === undefined ? currentSignal() : given.signal;
  if (typeof method !== "string") throw new ForbiddenCommand("a CDP command's method must be a string");
  checkCancelled(signal);
  if (wait <= 0) throw new CdpTimeout(method, wait);
  const link = browser.link;
  if (link !== null && !link.connected) throw new ConnectionLost();
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
          error: unknown
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
