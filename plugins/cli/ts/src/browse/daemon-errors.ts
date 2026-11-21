import { isSpace, strip } from "../py.ts";
import { formatG } from "../pylib/format.ts";
import { PyException } from "../pylib/str.ts";

export const POLICY_REFUSAL = "isn't allowed for the ardia command";

export type ErrorData = Readonly<Record<string, unknown>>;

export class BrowseError extends Error {
  readonly exitCode: number = 1;

  constructor(
    readonly text: string,
    readonly data?: ErrorData | null,
    readonly code?: string | null,
  ) {
    super(text);
  }
}

export class Unreachable extends BrowseError {
  override readonly exitCode: number = 2;
}

export class ConnectionLost extends BrowseError {
  override readonly exitCode: number = 2;

  constructor(message = "Ardia closed the connection (Stop was pressed, control was turned off, or Ardia quit)") {
    super(message, null, "connection_lost");
  }
}

export class OutcomeUnknown extends BrowseError {
  constructor(action: string, why: string) {
    super(`${why}; the outcome of ${action} is unknown, so it wasn't retried`, null, "outcome_unknown");
  }
}

function capitalized(text: string): string {
  const first = String.fromCodePoint(text.codePointAt(0) as number);
  return first.toUpperCase() + text.slice(first.length);
}

export class StaleRef extends BrowseError {
  constructor(ref: string, why: string) {
    const fix = why.includes("is now @") ? "use that ref" : "Run `ardia browse snapshot -i` again and use the new refs";
    super(`Stale ref @${ref}: ${why}. ${capitalized(fix)}`, null, "stale_ref");
  }
}

export const NOT_A_WEB_TAB = "the tab is gone, isn't a web page (an Ardia or extension page), or is in a window Ardia keeps for itself";
export const REFUSAL_HINTS: Readonly<Record<string, string>> = {
  "to that target": NOT_A_WEB_TAB,
  "on that target": NOT_A_WEB_TAB,
  "to that URL": "only http, https, data and about:blank pages can be opened",
  "on a tab the ardia command didn't open": "the viewport can be set only on a tab this command opened: `ardia browse open <url>`, then set it there",
  "with that option": "only a width, a height, a scale and mobile can be set",
  "on a tab that isn't off-screen": "Ardia sets a viewport only on a tab it has taken off-screen, which `ardia browse set viewport <w> <h>` does for a tab this session opened and never showed",
};

export function refusalReason(text: string, method: string): string {
  const refusal = text.indexOf(POLICY_REFUSAL);
  const said = refusal < 0 ? text : text.slice(0, refusal);
  if (!said.includes(method)) return "";
  if (method === "") throw new PyException("ValueError", "empty separator");
  return strip(said.slice(said.lastIndexOf(method) + method.length), isSpace);
}

export class Gated extends BrowseError {
  readonly refusal: string;

  constructor(
    readonly method: string,
    command?: string | null,
    detail?: string | null,
    reason?: string | null,
  ) {
    const why = reason || "";
    const refusal = [method, why, POLICY_REFUSAL].filter((part) => part).join(" ");
    const what = command ? `\`${command}\` needs ${method}` : `${method} is needed`;
    let message: string;
    if (why) {
      const hint = Object.hasOwn(REFUSAL_HINTS, why) ? REFUSAL_HINTS[why] : undefined;
      message = `${what}, which Ardia allows for the ardia command, but not ${why} (${refusal})` + (hint ? `: ${hint}` : "");
    } else {
      message = `${what}, and this Ardia's engine doesn't allow it yet (${refusal}): update Ardia`;
    }
    super(message + (detail ? ` (${detail})` : ""), { method, reason: why }, "policy_refused");
    this.reason = why;
    this.refusal = refusal;
  }

  readonly reason: string;

  during(command: string | null | undefined, detail?: string | null): Gated {
    return new Gated(this.method, command, detail, this.reason);
  }
}

export class CdpError extends BrowseError {
  readonly method: string;
  readonly cdpMessage: string;

  constructor(
    method: string,
    message: string,
    override?: { text: string; code: string } | null,
    readonly cdpCode: unknown = null,
  ) {
    super(override ? override.text : `${method}: ${message}`, null, override?.code ?? null);
    this.method = method;
    this.cdpMessage = message;
  }
}

export class NotFocusable extends CdpError {
  constructor(label: string) {
    super("DOM.focus", "Element is not focusable", {
      text:
        `${label} can't take focus (it's hidden, inert or a wrapper with no field inside). Click it to open ` +
        "its field, then snapshot -i and use the field that appears",
      code: "not_focusable",
    });
  }
}

export class CdpTimeout extends BrowseError {
  constructor(
    readonly method: string,
    seconds: number,
    why?: { text: string; code: string },
  ) {
    super(why ? why.text : `${method} got no answer in ${formatG(seconds)}s`, null, why?.code ?? null);
  }
}

export class PageBusy extends CdpTimeout {
  constructor(method: string, seconds: number, why: string) {
    super(method, seconds, { text: `${method} got no answer in ${formatG(seconds)}s: ${why}`, code: "page_busy" });
  }
}

export class Usage extends BrowseError {}
