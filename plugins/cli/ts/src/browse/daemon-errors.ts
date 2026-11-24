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

export const SUPERSEDED = "vocab_superseded";

export class StaleRef extends BrowseError {
  successor: string | null = null;
  matches: readonly string[] = [];
  ambiguous = false;

  constructor(
    readonly staleRef: string,
    why: string,
    given: string | null = null,
    code = "stale_ref",
  ) {
    const fix = given ?? (why.includes("is now @") ? "use that ref" : "Run `ardia browse snapshot -i` again and use the new refs");
    super(`Stale ref @${staleRef}: ${why}. ${capitalized(fix)}`, null, code);
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

const DOWNLOAD_INSTEAD =
  "`read --links <part of the link's address> --list` prints its full URL, and for a public text or JSON file " +
  "`read --http --raw <that URL>` fetches it; otherwise ask the user to download it";
const SCREENSHOTS_INSTEAD = "take a `screenshot` at each moment that matters";
const SIGN_IN_INSTEAD = "ask the user to sign in in the tab, then work there";
const TIMINGS_INSTEAD = "`eval` can read the page's own `performance` timings";
const OTHER_WAY = "do this step another way, or ask the user to do it";
export const FULL_CONTROL_ARDIA = "0.2.49";
export const NOT_YET_REASONS: ReadonlySet<string> = new Set(["with those editing commands"]);
export const NOT_YET: ReadonlyMap<string, string> = new Map([
  ["upload", "ask the user to choose the file in the page, then carry on"],
  ["download", DOWNLOAD_INSTEAD],
  ["wait --download", "ask the user to download the file"],
  ["set device", "`set viewport <w> <h>` sizes a tab this session opened and never showed"],
  ["set geo", "use the site's own location field, or ask the user to set the location"],
  ["set offline", "ask the user to take the computer offline if the check needs it"],
  ["set media", "read the page as it is, or ask the user to switch the system's light or dark appearance"],
  ["set headers", SIGN_IN_INSTEAD],
  ["set credentials", SIGN_IN_INSTEAD],
  ["set auth", SIGN_IN_INSTEAD],
  ["set permission", "ask the user to allow it when the site asks"],
  ["set permissions", "ask the user to allow it when the site asks"],
  ["cookies", "`eval document.cookie` reads the cookies a page script can see; for the rest, ask the user"],
  ["state", "`storage local` and `storage session` read and write a site's storage"],
  ["network route", "`network requests` lists what the page loads; to change answers, ask the user what the check needs"],
  ["record", SCREENSHOTS_INSTEAD],
  ["stream", SCREENSHOTS_INSTEAD],
  ["highlight", "`screenshot` shows the page"],
  ["clipboard", "`fill` or `type` puts text in, and `get value` (a field) or `get text` reads it out"],
  ["trace", TIMINGS_INSTEAD],
  ["profiler", TIMINGS_INSTEAD],
  ["perf", TIMINGS_INSTEAD],
  ["styles", "`get styles <sel>` prints the element's computed values"],
  ["issues", "`console` and `network requests` show most of the same problems"],
  ["logpoint", "`eval` reads a value at the moment you run it"],
]);

function insteadFor(command: string | null | undefined): string {
  if (!command) return OTHER_WAY;
  return NOT_YET.get(command) ?? NOT_YET.get(command.split(" ")[0] as string) ?? OTHER_WAY;
}

function knownLimit(command: string | null | undefined): boolean {
  return Boolean(command) && (NOT_YET.has(command as string) || NOT_YET.has((command as string).split(" ")[0] as string));
}

export function notYetMessage(command: string | null | undefined, method: string, refusal: string): string {
  const what = command ? `\`${command}\`` : method;
  if (!knownLimit(command)) {
    return (
      `${what} isn't allowed on this Ardia (${refusal}). Its engine keeps the ardia command to a short list of DevTools ` +
      `methods, and Ardia ${FULL_CONTROL_ARDIA} or later allows them all: update Ardia, or ${OTHER_WAY}`
    );
  }
  return (
    `${what} needs Ardia ${FULL_CONTROL_ARDIA} or later (${refusal}). This Ardia's engine keeps the ardia command to a short ` +
    `list of DevTools methods; ${FULL_CONTROL_ARDIA} lets it use them all, so update Ardia and run it again. ` +
    `Until then: ${insteadFor(command)}`
  );
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
    if (NOT_YET_REASONS.has(why)) {
      message = notYetMessage(command, method, refusal);
    } else if (why) {
      const hint = Object.hasOwn(REFUSAL_HINTS, why) ? REFUSAL_HINTS[why] : undefined;
      message = `${what}, which this Ardia allows for the ardia command, but not ${why} (${refusal})` + (hint ? `: ${hint}` : "") + `. Ardia ${FULL_CONTROL_ARDIA} or later has no such limit`;
    } else {
      message = notYetMessage(command, method, refusal);
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
