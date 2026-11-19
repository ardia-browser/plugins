import { formatG } from "../../pylib/format.ts";
import { type Browser, type CdpResult } from "../cdp/browser.ts";
import { Cancelled, checkCancelled, currentSignal, later, untilCancelled } from "../cdp/cancel.ts";
import { BrowseError, CdpError, OutcomeUnknown } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import { checkRequest, INPUT_METHODS, PAGE_SESSION_ONLY, PluginPolicy } from "./policy.ts";

export const INPUT_ANSWER_WAIT = 10;
export const EARLIER_INPUT_WAIT = 10;
export const ENGINE_CODES: readonly (readonly [string, string, string])[] = [
  ["ardia: tab_out_of_scope", "tab_out_of_scope", "plugin_out_of_scope"],
  ["ardia: document_changed", "document_changed", "plugin_lease_refused"],
];

export function unavailable(error: unknown): error is CdpError {
  return error instanceof CdpError && !error.code;
}

export function engineCoded(error: unknown): unknown {
  if (!(error instanceof CdpError)) return error;
  for (const [prefix, code, metric] of ENGINE_CODES) {
    if (error.cdpMessage.startsWith(prefix)) {
      flag(metric, true);
      return new BrowseError(error.text, null, code);
    }
  }
  return error;
}

function within<T>(work: Promise<T>, seconds: number, late: () => Error): Promise<T> {
  let stop = () => {};
  const timer = new Promise<never>((_, reject) => {
    stop = later(seconds * 1000, () => reject(late()));
  });
  return untilCancelled(Promise.race([work, timer]), currentSignal()).finally(stop);
}

export class PluginLink {
  private earlierInput: Promise<void> = Promise.resolve();
  private inputOutstanding = false;
  readonly pageSessions = new Set<string>();

  constructor(readonly browser: Browser) {}

  get inputInFlight(): boolean {
    return this.inputOutstanding;
  }

  async send(method: string, params: CdpResult = {}, session: string | null = null, timeout = 30): Promise<CdpResult> {
    checkRequest(method, params);
    if (PAGE_SESSION_ONLY.has(method) && (session === null || !this.pageSessions.has(session))) {
      throw new PluginPolicy(`plugin mode sends ${method} only on a page target's own session`);
    }
    if (INPUT_METHODS.has(method)) return this.input(method, params, session);
    try {
      return await this.browser.send(method, params, { session, timeout });
    } catch (error) {
      throw engineCoded(error);
    }
  }

  private async input(method: string, params: CdpResult, session: string | null): Promise<CdpResult> {
    if (this.inputOutstanding) {
      await within(this.earlierInput, EARLIER_INPUT_WAIT, () => new BrowseError(
        `An earlier input event on this page hasn't been answered in ${formatG(EARLIER_INPUT_WAIT)} s, so ${method} wasn't sent (plugin input goes one event at a time). Try the step again`,
        null,
        "input_unanswered",
      ));
    }
    checkCancelled();
    const sent = this.browser.send(method, params, { session, timeout: null, signal: null, mutation: true });
    this.inputOutstanding = true;
    this.earlierInput = sent.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.inputOutstanding = false;
    });
    try {
      return await within(sent, INPUT_ANSWER_WAIT, () => new OutcomeUnknown(`\`${method}\``, `Ardia didn't answer ${method} in ${formatG(INPUT_ANSWER_WAIT)}s after it was sent`));
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      throw engineCoded(error);
    }
  }
}
