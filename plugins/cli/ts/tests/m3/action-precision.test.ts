import { describe, expect, test } from "bun:test";
import { checkedFrom, HOLDS_FOCUS, listOptions, matchOptions, MAX_OPTIONS_LISTED, OVERLAY_INPUT, splitFinal } from "../../src/browse/act/choices.ts";
import { driftBetween, driftMessage, guardDrift, identityOf, refuseDrift, sameRole } from "../../src/browse/act/drift.ts";
import { clearField, COMMIT_CHECKS, fill, insertThenFinalKey, setChecked, setValue } from "../../src/browse/act/fields.ts";
import { pollTimes } from "../../src/browse/act/common.ts";
import { click, PREPARE_ACTION } from "../../src/browse/act/pointer.ts";
import { BLOCKER_AT, blockerPhrase, classify, findBlocker } from "../../src/browse/act/obstruction.ts";
import { PRECISION_COUNTS, PRECISION_FLAGS } from "../../src/browse/act/precision-metrics.ts";
import { fieldKind, type FieldRead, fieldRead, judgeReadback, latchSecret, READ_FIELD, readbackNote, SECRET_PROBE, secretField } from "../../src/browse/act/readback.ts";
import { maskSecretValues } from "../../src/browse/snapshot/collect.ts";
import { isSecret, markSecret, SECRET_FIELDS_PER_DOCUMENT } from "../../src/browse/state/secrets.ts";
import { Node } from "../../src/browse/snapshot/tree.ts";
import { entriesOf } from "../../src/browse/changes/report.ts";
import { Result, renderPlain } from "../../src/browse/daemon/render.ts";
import { liveWhile } from "../../src/browse/commands/cdp.ts";
import { sessionFor as rawSessionFor } from "../../src/browse/cdp/raw.ts";
import { LostMidAction, mayRetry, refusedRetry, sideEffectful } from "../../src/browse/act/retry.ts";
import { shield, sleep } from "../../src/browse/cdp/cancel.ts";
import { safeCode } from "../../src/browse/codes.ts";
import { outsideItsFrame } from "../../src/browse/act/pointer.ts";
import {
  DialogBlocked, dialogLine, downloadLine, openDialog, pageForSelector, raceDialog, ReceiptWatch, refuseIfDialog,
} from "../../src/browse/changes/dialogs.ts";
import { MUTATION_NOISE_FILTER, REACTION_STATE, reactionExpiry, STYLE_THROTTLE_MS, UNWATCH_REACTION, WATCH_REACTION } from "../../src/browse/changes/noise.ts";
import { decorate, dialogAfterwards, landedReport, NetworkWatch, netError, SETTLE_LIMIT, STALE_REQUEST } from "../../src/browse/changes/observe.ts";
import { diff, type View } from "../../src/browse/changes/report.ts";
import { asData, renderReport } from "../../src/browse/changes/text.ts";
import { budget, MAX_SCALE, noteManagedThrottle, noteRawThrottle, throttleFrom, throttleLine, throttleOf } from "../../src/browse/changes/throttle.ts";
import { checkedResult, filledResult } from "../../src/browse/commands/act.ts";
import { BrowseError, ConnectionLost, OutcomeUnknown } from "../../src/browse/daemon-errors.ts";
import { active, begin } from "../../src/browse/metrics.ts";
import { Element, type Page } from "../../src/browse/state/page.ts";
import type { State } from "../../src/browse/state/state.ts";
import { monotonic } from "../../src/browse/state/wait.ts";
import { isMetricCount, isMetricFlag } from "../../src/command-metrics.ts";
import { FakeRenderer } from "./act-fakes.ts";

function measured<T>(run: () => Promise<T>): Promise<[T, Map<string, unknown>]> {
  return begin({ argv: ["click"], telemetry: true }, async () => {
    const value = await run();
    return [value, new Map(active()?.values ?? [])] as [T, Map<string, unknown>];
  });
}

async function failure(run: () => Promise<unknown>): Promise<BrowseError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BrowseError) return error;
    throw error;
  }
  throw new Error("expected a BrowseError");
}

const VIEWPORT = { width: 1000, height: 800 };

describe("obstruction classes", () => {
  test("each layer is named by what it is", () => {
    expect(classify({ ...VIEWPORT, found: true, offscreen: true })).toBe("offscreen");
    expect(classify({ ...VIEWPORT, found: false })).toBe("offscreen");
    expect(classify({ ...VIEWPORT, found: true, clipped: true, modal: true })).toBe("clipped_scroll");
    expect(classify({ ...VIEWPORT, found: true, frameOwner: true, modal: true })).toBe("iframe");
    expect(classify({ ...VIEWPORT, found: true, modal: true, position: "fixed", layer: { top: 0, bottom: 800, left: 0, right: 1000 } })).toBe("modal");
    expect(classify({ ...VIEWPORT, found: true, position: "fixed", layer: { top: 0, bottom: 64, left: 0, right: 1000 } })).toBe("fixed_header");
    expect(classify({ ...VIEWPORT, found: true, position: "sticky", layer: { top: 740, bottom: 800, left: 0, right: 1000 } })).toBe("fixed_header");
    expect(classify({ ...VIEWPORT, found: true, position: "fixed", layer: { top: 600, bottom: 760, left: 900, right: 990 } })).toBe("overlay");
    expect(classify({ ...VIEWPORT, found: true, position: "absolute", layer: { top: 0, bottom: 700, left: 0, right: 900 } })).toBe("overlay");
    expect(classify({ ...VIEWPORT, found: true, position: "absolute", layer: { top: 10, bottom: 60, left: 10, right: 90 } })).toBe("sibling");
    expect(classify({ ...VIEWPORT, found: true, position: "static" })).toBe("sibling");
  });

  test("a tall fixed band is an overlay, not a header", () => {
    expect(classify({ ...VIEWPORT, found: true, position: "fixed", layer: { top: 0, bottom: 500, left: 0, right: 1000 } })).toBe("overlay");
  });

  test("the phrase names the class, the ref, the role and the name", () => {
    expect(blockerPhrase({ kind: "modal", ref: "e12", role: "dialog", name: "Sign up" })).toBe('a modal dialog (@e12 dialog "Sign up")');
    expect(blockerPhrase({ kind: "sibling", ref: null, role: "div", name: "" })).toBe("another element on top of it (div)");
  });

  test("the page probe walks shadow roots and slots", () => {
    expect(BLOCKER_AT).toContain("shadowRoot.elementFromPoint");
    expect(BLOCKER_AT).toContain("assignedSlot");
  });

  test("findBlocker mints a ref for the covering layer and counts the refusal", async () => {
    const element = new Element("F", "O1", 5, "@e5");
    const cover = new Element("F", "O2", 9, "the element in the way");
    const added: unknown[] = [];
    const page = {
      call: async (fn: string, args: unknown[]) => {
        expect(fn).toBe(BLOCKER_AT);
        return args[3] ? { objectId: "O2" } : { ...VIEWPORT, found: true, modal: true, role: "dialog", name: "Cookies" };
      },
      elementFrom: async () => cover,
      sessionFor: () => "S",
      send: async () => ({ nodes: AX(9, "dialog", "Cookie settings") }),
      state: { knownRef: () => null, addRef: (_page: unknown, node: Element, role: string, name: string) => (added.push([node.backendId, role, name]), "e40") },
    } as unknown as Page;
    const [blocker, values] = await measured(() => findBlocker(page, element, 10, 10));
    expect(blocker).toEqual({ kind: "modal", ref: "e40", role: "dialog", name: "Cookies" });
    expect(added).toEqual([[9, "dialog", "Cookie settings"]]);
    expect(values.get("click_blocker_ref")).toBe(true);
  });

  test("findBlocker reuses a ref the snapshot already gave", async () => {
    const element = new Element("F", "O1", 5, "@e5");
    const page = {
      call: async (_fn: string, args: unknown[]) => (args[3] ? { objectId: "O2" } : { ...VIEWPORT, found: true, position: "fixed", layer: { top: 0, bottom: 60, left: 0, right: 1000 }, role: "banner", name: "" }),
      elementFrom: async () => new Element("F", "O2", 7, "x"),
      state: { knownRef: () => ({ id: "e3" }), addRef: () => "never" },
    } as unknown as Page;
    expect(await findBlocker(page, element, 10, 10)).toEqual({ kind: "fixed_header", ref: "e3", role: "banner", name: "" });
  });

  class CoveredRenderer extends FakeRenderer {
    readonly minted: unknown[] = [];
    override readonly state = {
      leases: new Set<string>(), tabId: () => "t3", consentDismissed: null, clickNote: null, refForNode: () => "e9",
      knownRef: () => null,
      addRef: (_page: unknown, node: Element, role: string, name: string) => (this.minted.push([node.backendId, role, name]), "e41"),
    };

    override async send(method: string, given: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
      if (method === "Accessibility.getPartialAXTree") return { nodes: AX(77, "dialog", "Join our list") };
      return super.send(method, given);
    }

    override async call(fn: string, args: unknown[] = []): Promise<unknown> {
      if (fn === PREPARE_ACTION) return { ...((await super.call(fn, args)) as Record<string, unknown>), cover: "div.newsletter-modal" };
      if (fn === BLOCKER_AT) return args[3] ? { objectId: "M" } : { width: 1280, height: 800, found: true, modal: true, role: "dialog", name: "Join our list" };
      return super.call(fn, args);
    }

    async elementFrom(remote: unknown): Promise<Element | null> {
      return remote ? new Element("F", "M", 77, "modal") : null;
    }

    async elementsFrom(): Promise<Element[]> {
      return [];
    }
  }

  test("a covered click is refused before any pointer input, naming the class and the blocker's ref", async () => {
    const page = new CoveredRenderer();
    const [error, values] = await measured(() => failure(() => click(page.page, new Element("F", "O", 1, "@e1"), false)));
    expect(error.code).toBe("covered");
    expect(error.message).toBe('Element @e1 is covered by div.newsletter-modal, a modal dialog (@e41 dialog "Join our list"); dismiss @e41 first, snapshot again, then retry');
    expect(error.data).toMatchObject({ coveredBy: "div.newsletter-modal", obstruction: "modal", blocker: "@e41" });
    expect(page.minted).toEqual([[77, "dialog", "Join our list"]]);
    expect(page.calls().filter(([method]) => method === "Input.dispatchMouseEvent")).toEqual([]);
    expect(values.get("click_obstructed_modal")).toBe(true);
    expect(values.get("obstruction_refusals")).toBe(1);
  });

  test("a probe that fails gives no blocker rather than an error", async () => {
    const page = {
      call: async () => {
        throw new BrowseError("gone", null, "document_changed");
      },
    } as unknown as Page;
    expect(await findBlocker(page, new Element("F", "O", 1, "@e1"), 0, 0)).toBeNull();
  });
});

const AX = (backend: number, role: string, name: string) => [{ nodeId: "1", ignored: false, role: { value: role }, name: { value: name }, backendDOMNodeId: backend }];

function axPage(nodes: unknown, refs: Map<string, unknown> = new Map()): Page & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    sessionFor: () => "S",
    send: async (method: string, params: unknown) => {
      asked.push([method, params]);
      return { nodes };
    },
    state: { refs },
  } as unknown as Page & { asked: unknown[] };
}

describe("role and name drift", () => {
  test("no drift when the role and name are the same up to spacing", () => {
    expect(driftBetween({ role: "button", name: "Save  draft" }, { role: "button", name: "Save draft" })).toBeNull();
  });

  test("a renamed or re-roled element drifts", () => {
    expect(driftBetween({ role: "button", name: "Save" }, { role: "button", name: "Delete" })?.field).toBe("name");
    expect(driftBetween({ role: "button", name: "Go" }, { role: "link", name: "Go" })?.field).toBe("role");
    expect(driftBetween({ role: "button", name: "Go" }, { role: "link", name: "Stop" })?.field).toBe("both");
  });

  test("an unknown recorded role or an unreadable element is not drift", () => {
    expect(driftBetween({ role: "", name: "x" }, { role: "button", name: "y" })).toBeNull();
    expect(driftBetween({ role: "button", name: "x" }, null)).toBeNull();
  });

  test("the message says what changed and how to recover", () => {
    const message = driftMessage("e7", "click", { field: "name", was: { role: "button", name: "Save" }, now: { role: "button", name: "Delete" } });
    expect(message).toContain('@e7 changed since it was last seen, so click wasn\'t sent: its name went from button "Save" to button "Delete"');
    expect(message).toContain("snapshot -i");
  });

  test("the identity is read the way the snapshot reads it", () => {
    expect(identityOf(AX(4, "DisclosureTriangle", " More "), 4)).toEqual({ role: "button", name: "More" });
    expect(identityOf([{ nodeId: "1", ignored: false, role: { value: "Date" }, name: { value: "Due" }, backendDOMNodeId: 4 }], 4)).toEqual({ role: "textbox", name: "Due" });
    expect(identityOf([{ nodeId: "1", ignored: true, role: { value: "button" }, backendDOMNodeId: 4 }], 4)).toBe("ignored");
    expect(identityOf([], 4)).toBeNull();
  });

  test("a ref whose element was renamed is refused before acting, and counted", async () => {
    const page = axPage(AX(5, "button", "Delete account"));
    const ref = { id: "e7", role: "button", name: "Save", backend: 5 } as never;
    const [error, values] = await measured(() => failure(() => refuseDrift(page, new Element("F", "O", 5, "@e7"), ref, "click")));
    expect(error.code).toBe("ref_drifted");
    expect(error.data).toMatchObject({ ref: "@e7", field: "name", was: { role: "button", name: "Save" }, now: { role: "button", name: "Delete account" } });
    expect(values.get("ref_drift_refused")).toBe(true);
    expect(values.get("drift_refusals")).toBe(1);
    expect(page.asked).toEqual([["Accessibility.getPartialAXTree", { backendNodeId: 5, fetchRelatives: false }]]);
  });

  test("an unchanged ref passes", async () => {
    const page = axPage(AX(5, "button", "Save"));
    await refuseDrift(page, new Element("F", "O", 5, "@e7"), { id: "e7", role: "button", name: "Save", backend: 5 } as never, "click");
  });

  test("only refs, and only acting commands, are checked", async () => {
    const refs = new Map([["e2", { id: "e2", role: "link", name: "Home", backend: 3 }]]);
    const page = axPage(AX(3, "button", "Logout"), refs);
    await guardDrift(page, new Element("F", "O", 3, "#home"), "#home", "click");
    await guardDrift(page, new Element("F", "O", 3, "@e2"), "@e2", "get");
    expect(page.asked).toEqual([]);
    expect((await failure(() => guardDrift(page, new Element("F", "O", 3, "@e2"), "@e2", "drag"))).code).toBe("ref_drifted");
  });
});

describe("retry policy", () => {
  test("only read-only commands are retried, and only after a detach", () => {
    const detached = new BrowseError("detached", null, "tab_detached");
    expect(mayRetry("snapshot", detached)).toBe(true);
    expect(mayRetry("get", new BrowseError("x", null, "document_changed"))).toBe(true);
    for (const command of ["click", "fill", "type", "select", "drag", "eval", "press", "check", "upload"]) expect(mayRetry(command, detached)).toBe(false);
    expect(mayRetry("snapshot", new ConnectionLost())).toBe(false);
    expect(mayRetry("snapshot", new BrowseError("x", null, "not_found"))).toBe(false);
  });

  test("unknown commands count as side-effectful", () => {
    expect(sideEffectful("click")).toBe(true);
    expect(sideEffectful("frobnicate")).toBe(true);
    expect(sideEffectful("snapshot")).toBe(false);
  });

  test("a side-effectful command cut off by a detach becomes an unknown outcome", async () => {
    const [error, values] = await measured(async () => refusedRetry("click", new BrowseError("Ardia detached this tab", null, "tab_detached")));
    expect(error).toBeInstanceOf(OutcomeUnknown);
    expect(error.code).toBe("outcome_unknown");
    expect(error.message).toContain("the outcome of `click` is unknown, so it wasn't retried");
    expect(values.get("retry_refusals")).toBe(1);
  });

  test("other errors and read-only commands pass through", () => {
    const missing = new BrowseError("nope", null, "not_found");
    expect(refusedRetry("click", missing)).toBe(missing);
    const detached = new BrowseError("detached", null, "tab_detached");
    expect(refusedRetry("snapshot", detached)).toBe(detached);
  });
});

describe("insert then the last key", () => {
  test("splits off the last character", () => {
    expect(splitFinal("hello")).toEqual(["hell", "o"]);
    expect(splitFinal("a")).toEqual(["", "a"]);
    expect(splitFinal("naïve 😀")).toEqual(["naïve ", "😀"]);
  });

  test("control characters, combining marks and joiners are inserted whole", () => {
    expect(splitFinal("")).toBeNull();
    expect(splitFinal("line\n")).toBeNull();
    expect(splitFinal("tab\t")).toBeNull();
    expect(splitFinal("café")).toBeNull();
    expect(splitFinal("👩‍")).toBeNull();
  });

  class TypingRenderer extends FakeRenderer {
    focused = true;

    override async call(fn: string, args: unknown[] = []): Promise<unknown> {
      if (fn === HOLDS_FOCUS) return this.focused;
      return super.call(fn, args);
    }

    override async send(method: string, given: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
      if (method === "Input.insertText") {
        this.counts["beforeinput"] = (this.counts["beforeinput"] ?? 0) + 1;
        this.counts["input"] = (this.counts["input"] ?? 0) + 1;
      }
      return super.send(method, given);
    }
  }

  test("fast typing inserts all but the last character, then presses the last one for real", async () => {
    const page = new TypingRenderer();
    const [, values] = await measured(() => insertThenFinalKey(page.page, new Element("F", "O", 1, "@e1"), "Lond"));
    const typed = page.params.filter(([method]) => method.startsWith("Input."));
    expect(typed.map(([method, params]) => [method, params["text"] ?? null, params["type"] ?? null])).toEqual([
      ["Input.insertText", "Lon", null],
      ["Input.dispatchKeyEvent", "d", "keyDown"],
      ["Input.dispatchKeyEvent", null, "keyUp"],
    ]);
    expect(values.get("fill_final_key")).toBe(true);
    expect(values.get("fill_inserted_text")).toBe(true);
  });

  test("a single character is only a key press", async () => {
    const page = new TypingRenderer();
    await insertThenFinalKey(page.page, new Element("F", "O", 1, "@e1"), "x");
    expect(page.params.filter(([method]) => method.startsWith("Input.")).map(([method]) => method)).toEqual(["Input.dispatchKeyEvent", "Input.dispatchKeyEvent"]);
  });

  test("text ending in a newline is inserted whole, so no Enter submits a form", async () => {
    const page = new TypingRenderer();
    await insertThenFinalKey(page.page, new Element("F", "O", 1, "@e1"), "two\nlines\n");
    expect(page.params.filter(([method]) => method.startsWith("Input.")).map(([method, params]) => [method, params["text"]])).toEqual([["Input.insertText", "two\nlines\n"]]);
  });
});

const FIELD: FieldRead = { tag: "input", type: "text", value: "", length: null, secret: false, maxLength: -1, autocomplete: "", hint: "", combo: null };

describe("field readback", () => {
  test("kinds come from the type, autocomplete and the field's own words", () => {
    expect(fieldKind({ ...FIELD, type: "password" })).toBe("password");
    expect(fieldKind({ ...FIELD, autocomplete: "cc-number" })).toBe("card");
    expect(fieldKind({ ...FIELD, hint: "card number" })).toBe("card");
    expect(fieldKind({ ...FIELD, type: "tel" })).toBe("phone");
    expect(fieldKind({ ...FIELD, hint: "mobile phone" })).toBe("phone");
    expect(fieldKind({ ...FIELD, hint: "date of birth" })).toBe("date");
    expect(fieldKind({ ...FIELD, autocomplete: "cc-exp" })).toBe("date");
    expect(fieldKind({ ...FIELD, type: "number" })).toBe("number");
    expect(fieldKind({ ...FIELD, type: "email" })).toBe("email");
    expect(fieldKind({ ...FIELD, tag: "div", type: null })).toBe("rich");
    expect(fieldKind(FIELD)).toBe("text");
  });

  test("an exact or space-equal value is ok", () => {
    expect(judgeReadback({ ...FIELD, value: "Hello" }, "Hello").status).toBe("ok");
    expect(judgeReadback({ ...FIELD, value: " Hello  world " }, "Hello world").status).toBe("ok");
  });

  test("passwords are compared by length and never echoed", () => {
    const pw = { ...FIELD, type: "password" };
    expect(judgeReadback({ ...pw, value: "s3cret" }, "s3cret")).toEqual({ status: "ok", kind: "password", reason: null, held: null });
    const short = judgeReadback({ ...pw, value: "s3c" }, "s3cret");
    expect(short.status).toBe("did_not_commit");
    expect(short.held).toBeNull();
    expect(short.reason).toBe("it holds 3 characters, not 6");
    expect(judgeReadback({ ...pw, value: "s3cr", maxLength: 4 }, "s3cret").reason).toBe("its maxlength cut it to 4 characters");
  });

  test("masked fields of the same length are ok", () => {
    expect(judgeReadback({ ...FIELD, value: "••••" }, "1234").status).toBe("ok");
  });

  test("phones and cards compare their digits", () => {
    expect(judgeReadback({ ...FIELD, type: "tel", value: "(555) 123-4567" }, "5551234567").status).toBe("ok");
    expect(judgeReadback({ ...FIELD, autocomplete: "cc-number", value: "4242 4242 4242 4242" }, "4242424242424242").status).toBe("ok");
    const cut = judgeReadback({ ...FIELD, type: "tel", value: "555-123" }, "5551234567");
    expect(cut.status).toBe("did_not_commit");
    expect(cut.reason).toBe("it kept only 6 of 10 digits");
  });

  test("dates compare their numbers in any order", () => {
    expect(judgeReadback({ ...FIELD, hint: "date", value: "01/05/2024" }, "2024-01-05").status).toBe("ok");
    expect(judgeReadback({ ...FIELD, hint: "date", value: "01/06/2024" }, "2024-01-05").status).toBe("did_not_commit");
  });

  test("maxlength truncation is reported", () => {
    const read = judgeReadback({ ...FIELD, value: "abcd", maxLength: 4 }, "abcdef");
    expect(read).toEqual({ status: "did_not_commit", kind: "text", reason: "its maxlength cut it to 4 characters", held: "abcd" });
  });

  test("empty after typing, and something else, did not commit", () => {
    expect(judgeReadback({ ...FIELD, value: "" }, "abc").reason).toBe("it is empty after typing");
    expect(judgeReadback({ ...FIELD, value: "xyz" }, "abc").reason).toBe('it holds "xyz"');
  });

  test("a typeahead that completed the text, numbers and emails are ok", () => {
    expect(judgeReadback({ ...FIELD, combo: "typeahead", value: "New York" }, "new y").status).toBe("ok");
    expect(judgeReadback({ ...FIELD, type: "number", value: "10.50" }, "10.5").status).toBe("ok");
    expect(judgeReadback({ ...FIELD, type: "email", value: "A@B.co" }, "a@b.co").status).toBe("ok");
    expect(judgeReadback({ ...FIELD, tag: "div", type: null, value: "Hi there\n" }, "Hi there").status).toBe("ok");
    expect(judgeReadback({ ...FIELD, value: "1,000" }, "1000").status).toBe("ok");
  });

  test("an unreadable field is unverified", () => {
    expect(judgeReadback({ ...FIELD, value: null }, "abc").status).toBe("unverified");
  });

  test("the answer carries the status, and a warning only when it didn't commit", () => {
    const bad = judgeReadback({ ...FIELD, value: "ab", maxLength: 2 }, "abc");
    const result = filledResult("filled", "@e3", false, "abc", null, bad);
    expect(result.data).toMatchObject({ filled: "@e3", verify: { status: "did_not_commit", kind: "text", reason: "its maxlength cut it to 2 characters" } });
    expect(result.text).toContain("→ The field didn't keep it as typed: its maxlength cut it to 2 characters");
    const ok = filledResult("filled", "@e3", false, "abc", null, judgeReadback({ ...FIELD, value: "abc" }, "abc"));
    expect(ok.data).toMatchObject({ verify: { status: "ok" } });
    expect(ok.text ?? "").not.toContain("→");
    expect(readbackNote(null)).toBe("");
  });
});

describe("select lists its options", () => {
  const rows = [
    { value: "us", label: "United States", text: "United States" },
    { value: "uk", label: "United Kingdom", text: "United Kingdom" },
    { value: "ca1", label: "Canada", text: "Canada" },
    { value: "ca2", label: "Canada", text: "Canada" },
  ];

  test("a value, a label or a text picks the option's value", () => {
    expect(matchOptions(["us"], rows, "@e1")).toEqual(["us"]);
    expect(matchOptions(["United Kingdom"], rows, "@e1")).toEqual(["uk"]);
  });

  test("no match lists every option", async () => {
    const error = await failure(async () => matchOptions(["France"], rows, "@e1"));
    expect(error.code).toBe("no_match");
    expect(error.message).toBe('No option of @e1 matches "France". Its options: "United States" (value "us"), "United Kingdom" (value "uk"), "Canada" (value "ca1"), "Canada" (value "ca2")');
    expect((error.data?.["options"] as unknown[]).length).toBe(4);
  });

  test("two different options with the same label are ambiguous, and both are listed", async () => {
    const error = await failure(async () => matchOptions(["Canada"], rows, "@e1"));
    expect(error.code).toBe("ambiguous");
    expect(error.message).toContain('"Canada" matches 2 options of @e1: "Canada" (value "ca1"), "Canada" (value "ca2")');
  });

  test("a long list is cut with a count", () => {
    const many = Array.from({ length: MAX_OPTIONS_LISTED + 5 }, (_, index) => ({ value: String(index), label: `Item ${index}`, text: `Item ${index}` }));
    expect(listOptions(many)).toEndWith("(and 5 more)");
  });
});

describe("check and uncheck are level-triggered", () => {
  class CheckRenderer extends FakeRenderer {
    checked: boolean | "mixed" | null = false;

    override async call(fn: string, args: unknown[] = []): Promise<unknown> {
      if (fn.includes("aria-pressed")) return this.checked;
      if (fn.includes("ardiaBrowse.info")) return { connected: true, checked: this.checked === true };
      return super.call(fn, args);
    }

    override async send(method: string, given: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
      const sent = await super.send(method, given);
      if (method === "Input.dispatchMouseEvent" && given?.["type"] === "mouseReleased") this.checked = this.checked !== true;
      return sent;
    }
  }

  test("a box already in the wanted state isn't clicked", async () => {
    const page = new CheckRenderer();
    page.checked = true;
    const [changed, values] = await measured(() => setChecked(page.page, new Element("F", "O", 1, "@e1"), true, false));
    expect(changed).toBe(false);
    expect(page.calls()).toEqual([]);
    expect(values.get("check_already_set")).toBe(true);
  });

  test("an ARIA switch that reads aria-checked=false is clicked once", async () => {
    const page = new CheckRenderer();
    page.checked = false;
    expect(await setChecked(page.page, new Element("F", "O", 1, "@e1"), true, false)).toBe(true);
    expect(page.calls().filter(([, kind]) => kind === "mousePressed").length).toBe(1);
    expect(await setChecked(page.page, new Element("F", "O", 1, "@e1"), true, false)).toBe(false);
    expect(page.calls().filter(([, kind]) => kind === "mousePressed").length).toBe(1);
  });

  test("the answer says nothing was clicked", () => {
    expect(checkedResult(true, "@e1", false).text).toBe("✓ Already checked, so nothing was clicked");
    expect(checkedResult(false, "@e1", false).data).toEqual({ unchecked: "@e1", changed: false });
    expect(checkedResult(true, "@e1", true).text ?? "").not.toContain("Already");
  });

  test("only booleans and mixed are states", () => {
    expect(checkedFrom(true)).toBe(true);
    expect(checkedFrom("mixed")).toBe("mixed");
    expect(checkedFrom("true")).toBeNull();
    expect(checkedFrom(undefined)).toBeNull();
  });
});

describe("noise-filtered mutations", () => {
  const keep = new Function(`return ${MUTATION_NOISE_FILTER}`)() as (record: Record<string, unknown>, seen: WeakMap<object, number>, now: number) => boolean;
  const target = (attributes: Record<string, string>) => ({ getAttribute: (name: string) => attributes[name] ?? null, data: "" });

  test("an attribute written with the value it already had is ignored", () => {
    expect(keep({ type: "attributes", attributeName: "class", oldValue: "a", target: target({ class: "a" }) }, new WeakMap(), 0)).toBe(false);
    expect(keep({ type: "attributes", attributeName: "class", oldValue: "a", target: target({ class: "b" }) }, new WeakMap(), 0)).toBe(true);
  });

  test("style changes count at most once per 200 ms per element", () => {
    const seen = new WeakMap<object, number>();
    const one = target({ style: "left: 1px" });
    const two = target({ style: "left: 9px" });
    const change = (node: object, now: number) => keep({ type: "attributes", attributeName: "style", oldValue: "left: 0px", target: node }, seen, now);
    expect(change(one, 1000)).toBe(true);
    expect(change(one, 1000 + STYLE_THROTTLE_MS - 1)).toBe(false);
    expect(change(two, 1001)).toBe(true);
    expect(change(one, 1000 + STYLE_THROTTLE_MS)).toBe(true);
  });

  test("text and child changes count when something changed", () => {
    expect(keep({ type: "characterData", oldValue: "a", target: { data: "a" } }, new WeakMap(), 0)).toBe(false);
    expect(keep({ type: "characterData", oldValue: "a", target: { data: "b" } }, new WeakMap(), 0)).toBe(true);
    expect(keep({ type: "childList", addedNodes: [1], removedNodes: [] }, new WeakMap(), 0)).toBe(true);
    expect(keep({ type: "childList", addedNodes: [], removedNodes: [] }, new WeakMap(), 0)).toBe(false);
  });

  test("the reaction watch carries the filter and watches same-origin frames", () => {
    expect(WATCH_REACTION).toContain("const keep = (record, seen, now) =>");
    expect(WATCH_REACTION).toContain("attributeOldValue: true");
    expect(WATCH_REACTION).toContain('document.querySelectorAll("iframe, frame")');
    expect(() => new Function(`return ${WATCH_REACTION}`)()).not.toThrow();
    expect(() => new Function(`return ${REACTION_STATE}`)()).not.toThrow();
    expect(() => new Function(`return ${UNWATCH_REACTION}`)()).not.toThrow();
  });
});

class WatchPage {
  readonly state = { listeners: [] as unknown[] };
  readonly overrides = new Map<string, Record<string, unknown> | null>();
  readonly mainFrame = "F";
  readonly targetId = "T";
  sessionId: string | null = "S";
  networkOn = true;

  async send(): Promise<Record<string, unknown>> {
    return {};
  }

  get page(): Page {
    return this as unknown as Page;
  }
}

describe("network-quiet settle", () => {
  test("an event stream neither keeps it busy nor resets the quiet clock", async () => {
    const page = new WatchPage();
    const watch = new NetworkWatch(page.page);
    await watch.start();
    const before = watch.lastEvent;
    await sleep(0.02);
    const [, values] = await measured(async () => {
      watch.listener(page.page, "Network.requestWillBeSent", { requestId: "1", type: "EventSource", request: { method: "GET", url: "https://x/stream" } });
      watch.listener(page.page, "Network.dataReceived", { requestId: "1" });
    });
    expect(watch.busy()).toBe(false);
    expect(watch.lastEvent).toBe(before);
    expect(values.get("settle_ignored_streams")).toBe(true);
    await watch.stop();
  });

  test("a read in flight longer than the sweep stops counting; a write or a document doesn't", async () => {
    const page = new WatchPage();
    const watch = new NetworkWatch(page.page);
    await watch.start();
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "poll", type: "XHR", request: { method: "GET", url: "https://x/poll" } });
    expect(watch.busy()).toBe(true);
    (watch.records.get("poll") as { started: number }).started = monotonic() - STALE_REQUEST - 0.01;
    const [busy, values] = await measured(async () => watch.busy());
    expect(busy).toBe(false);
    expect(values.get("settle_swept_stale_requests")).toBe(true);
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "save", type: "Fetch", request: { method: "POST", url: "https://x/save" } });
    (watch.records.get("save") as { started: number }).started = monotonic() - 10;
    expect(watch.busy()).toBe(true);
    watch.listener(page.page, "Network.loadingFinished", { requestId: "save" });
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "doc", type: "Document", frameId: "F", request: { method: "GET", url: "https://x/next" } });
    (watch.records.get("doc") as { started: number }).started = monotonic() - 10;
    expect(watch.busy()).toBe(true);
    await watch.stop();
  });

  test("a failed main-frame navigation keeps its net::ERR code", async () => {
    const page = new WatchPage();
    const watch = new NetworkWatch(page.page);
    await watch.start();
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "d", type: "Document", frameId: "F", request: { method: "GET", url: "https://nowhere.invalid/" } });
    watch.listener(page.page, "Network.loadingFailed", { requestId: "d", errorText: "net::ERR_NAME_NOT_RESOLVED" });
    expect(watch.navigationError).toBe("net::ERR_NAME_NOT_RESOLVED");
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "s", type: "Document", frameId: "child", request: { method: "GET", url: "https://ads/" } });
    watch.listener(page.page, "Network.loadingFailed", { requestId: "s", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
    expect(watch.navigationError).toBe("net::ERR_NAME_NOT_RESOLVED");
    await watch.stop();
  });

  test("aborted and canceled loads aren't navigation errors", () => {
    expect(netError("net::ERR_ABORTED")).toBe(false);
    expect(netError("net::ERR_CONNECTION_REFUSED")).toBe(true);
    expect(netError("canceled")).toBe(false);
  });

  test("the budget is the plain limit without throttling", () => {
    const watch = new NetworkWatch(new WatchPage().page);
    expect(watch.limit).toBe(SETTLE_LIMIT);
    expect(watch.stale).toBe(STALE_REQUEST);
  });
});

describe("throttle-scaled budgets", () => {
  test("CPU and network throttling scale waits, capped", () => {
    expect(throttleFrom(new Map())).toBeNull();
    expect(throttleFrom(new Map([["Emulation.setCPUThrottlingRate", { rate: 4 }]]))?.scale).toBe(4);
    expect(throttleFrom(new Map([["Emulation.setCPUThrottlingRate", { rate: 1 }]]))).toBeNull();
    expect(throttleFrom(new Map([["Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: -1 }]]))?.scale).toBe(5);
    expect(throttleFrom(new Map([["Network.emulateNetworkConditions", { offline: false, latency: 2000, downloadThroughput: 50_000 }]]))?.scale).toBe(MAX_SCALE);
    expect(throttleFrom(new Map([["Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1 }]]))).toEqual({ cpu: null, latencyMs: null, throughput: null, offline: true, scale: 1 });
  });

  test("set overrides and raw cdp calls both count", () => {
    const page = new WatchPage();
    expect(throttleOf(page.page)).toBeNull();
    noteRawThrottle(page.state, "T", "Emulation.setCPUThrottlingRate", { rate: 3 });
    noteRawThrottle(page.state, "T", "Page.reload", {});
    expect(throttleOf(page.page)?.cpu).toBe(3);
    page.overrides.set("Emulation.setCPUThrottlingRate", { rate: 6 });
    noteManagedThrottle(page.page, "Emulation.setCPUThrottlingRate");
    expect(throttleOf(page.page)?.scale).toBe(6);
  });

  test("budgets multiply and the watch's limits follow", async () => {
    const page = new WatchPage();
    page.overrides.set("Emulation.setCPUThrottlingRate", { rate: 2 });
    const [scaled, values] = await measured(async () => budget(page.page, 1.5));
    expect(scaled).toBe(3);
    expect(values.get("settle_throttle_scaled")).toBe(true);
    expect(budget(null, 1.5)).toBe(1.5);
    const watch = new NetworkWatch(page.page);
    expect(watch.limit).toBe(SETTLE_LIMIT * 2);
    expect(watch.stale).toBe(STALE_REQUEST * 2);
  });

  test("the receipt line names each override and the scale", () => {
    const throttle = throttleFrom(new Map<string, Record<string, unknown>>([["Emulation.setCPUThrottlingRate", { rate: 4 }], ["Network.emulateNetworkConditions", { latency: 150, downloadThroughput: 204800 }]]));
    expect(throttleLine(throttle as never)).toBe("(throttled: CPU 4× slower, 150 ms latency, 200 KB/s down; waits were 4.88× longer)");
  });
});

type FakeDialogPage = Page & { dialog: Record<string, unknown> | null };

function dialogPage(autoDialog = true): FakeDialogPage {
  return { dialog: null, state: { autoDialog, listeners: [] }, frames: new Map([["F", {}]]), targetId: "T" } as unknown as FakeDialogPage;
}

describe("blocking dialogs", () => {
  test("an open confirm refuses the action at once, with the dialog and how to answer it", async () => {
    const page = dialogPage();
    page.dialog = { type: "confirm", message: "Delete everything?" };
    const started = monotonic();
    const [error, values] = await measured(() => failure(() => refuseIfDialog(page, "`click`")));
    expect(monotonic() - started).toBeLessThan(0.2);
    expect(error).toBeInstanceOf(DialogBlocked);
    expect(error.code).toBe("dialog_blocked");
    expect(error.message).toBe(
      'A JavaScript confirm dialog saying "Delete everything?" is open on this tab, and the page is frozen until it\'s answered, so `click` wasn\'t sent. ' +
        "Nothing answers it automatically: answer it with `ardia browse dialog accept` or `ardia browse dialog dismiss`, then go on",
    );
    expect(error.data).toEqual({ dialog: { type: "confirm", message: "Delete everything?", defaultPrompt: null }, landed: false });
    expect(values.get("dialog_blocked_actions")).toBe(1);
  });

  test("a prompt says to give its text", async () => {
    const page = dialogPage();
    page.dialog = { type: "prompt", message: "Name?", defaultPrompt: "x" };
    expect((await failure(() => refuseIfDialog(page, "`fill`"))).message).toContain("`ardia browse dialog accept <text>`");
  });

  test("an alert that is being accepted automatically doesn't block", async () => {
    const page = dialogPage();
    page.dialog = { type: "alert", message: "Saved" };
    setTimeout(() => (page.dialog = null), 50);
    await refuseIfDialog(page, "`click`");
  });

  test("with automatic answers off, an alert blocks too", async () => {
    const page = dialogPage(false);
    page.dialog = { type: "alert", message: "Hi" };
    expect((await failure(() => refuseIfDialog(page, "`click`"))).code).toBe("dialog_blocked");
  });

  test("a dialog that opens mid-action fails it fast instead of hanging", async () => {
    const page = dialogPage();
    const hanging = () => sleep(60).then(() => "never");
    setTimeout(() => (page.dialog = { type: "beforeunload", message: "" }), 30);
    setTimeout(() => (page.dialog = { type: "confirm", message: "Leave?" }), 60);
    const started = monotonic();
    const error = await failure(() => raceDialog(page, hanging, "`click`"));
    expect(monotonic() - started).toBeLessThan(2);
    expect(error.message).toStartWith('`click` opened a JavaScript confirm dialog saying "Leave?", and the page is frozen until it\'s answered.');
    expect(error.data?.["landed"]).toBe(true);
  });

  test("work that finishes first wins, and its errors pass through", async () => {
    const page = dialogPage();
    expect(await raceDialog(page, () => sleep(0.02).then(() => "done"), "`click`")).toBe("done");
    const boom = new BrowseError("boom", null, "x");
    expect(await failure(() => raceDialog(page, () => Promise.reject(boom), "`click`"))).toBe(boom);
  });

  test("the page for a selector is the ref's tab, else the current one", () => {
    const one = dialogPage();
    const two = dialogPage();
    const state = { refs: new Map([["e4", { target: "B" }]]), current: "A", pages: new Map([["A", one], ["B", two]]), autoDialog: true } as unknown as State;
    expect(pageForSelector(state, "@e4")).toBe(two);
    expect(pageForSelector(state, "#x")).toBe(one);
    expect(pageForSelector(state, null)).toBe(one);
    expect(openDialog(state)).toBeNull();
    two.dialog = { type: "alert" };
    expect(openDialog(state)).toBeNull();
    two.dialog = { type: "confirm" };
    expect(openDialog(state)).toEqual({ type: "confirm" });
  });
});

describe("dialog and download receipts", () => {
  test("dialogs and downloads during an action land in its receipt", async () => {
    const page = dialogPage();
    const watch = new ReceiptWatch(page);
    watch.start();
    expect((page.state.listeners as unknown[]).length).toBe(1);
    const fire = (from: Page | null, method: string, params: Record<string, unknown>) => watch.listener(from, method, params);
    fire(page, "Page.javascriptDialogOpening", { type: "alert", message: "Saved!" });
    fire(page, "Page.javascriptDialogClosed", {});
    fire(page, "Page.javascriptDialogOpening", { type: "confirm", message: "Really?" });
    fire(null, "Browser.downloadWillBegin", { frameId: "F", guid: "g1", suggestedFilename: "report.pdf" });
    fire(null, "Browser.downloadWillBegin", { frameId: "other", guid: "g2", suggestedFilename: "not-mine.zip" });
    fire(null, "Browser.downloadProgress", { guid: "g1", state: "completed" });
    fire(page, "Page.downloadWillBegin", { frameId: "F", guid: "g3", suggestedFilename: "data.csv" });
    page.dialog = { type: "confirm", message: "Really?" };
    watch.stop();
    expect((page.state.listeners as unknown[]).length).toBe(0);
    const [receipt, values] = await measured(async () => watch.receipt());
    expect(receipt).toEqual({
      dialogs: [
        { type: "alert", message: "Saved!", handled: "auto_accepted" },
        { type: "confirm", message: "Really?", handled: "open" },
      ],
      downloads: [
        { guid: "g1", name: "report.pdf", state: "completed" },
        { guid: "g3", name: "data.csv", state: "inProgress" },
      ],
    });
    expect(values.get("dialog_in_receipt")).toBe(true);
    expect(values.get("download_in_receipt")).toBe(true);
  });

  test("a dialog already open shows in the receipt even without an event", () => {
    const page = dialogPage();
    page.dialog = { type: "prompt", message: "Code?" };
    const watch = new ReceiptWatch(page);
    expect(watch.receipt().dialogs).toEqual([{ type: "prompt", message: "Code?", handled: "open" }]);
  });

  test("receipt lines read plainly", () => {
    expect(dialogLine({ type: "alert", message: "Saved", handled: "auto_accepted" })).toBe('! alert dialog "Saved" (accepted automatically; --no-auto-dialog leaves these for you to answer)');
    expect(dialogLine({ type: "confirm", message: "Sure?", handled: "open" })).toBe('! confirm dialog "Sure?" is open: answer it with `ardia browse dialog accept` or `ardia browse dialog dismiss`, then go on');
    expect(downloadLine({ guid: "g", name: "a.pdf", state: "inProgress" })).toBe('↓ download "a.pdf" (in progress)');
  });

  const VIEW: View = { target: "T", loader: "L", url: "https://x/", title: "X", entries: [], containers: new Set() };

  test("the change report renders and carries dialogs, downloads, throttling and net errors", () => {
    const report = diff(VIEW, VIEW, []);
    report.dialogs = [{ type: "alert", message: "Hi", handled: "auto_accepted" }];
    report.downloads = [{ guid: "g", name: "a.pdf", state: "completed" }];
    report.navigationError = "net::ERR_CONNECTION_REFUSED";
    report.throttle = throttleFrom(new Map([["Emulation.setCPUThrottlingRate", { rate: 4 }]]));
    report.unsettled = true;
    report.settleLimit = 6;
    const text = renderReport(report);
    expect(text).toContain("✗ the page didn't load: net::ERR_CONNECTION_REFUSED");
    expect(text).toContain('! alert dialog "Hi" (accepted automatically');
    expect(text).toContain('↓ download "a.pdf" (completed)');
    expect(text).toContain("(the page was still busy after 6 s; snapshot again for the final state)");
    expect(text).toContain("(throttled: CPU 4× slower; waits were 4× longer)");
    const data = asData(report);
    expect(data["navigationError"]).toBe("net::ERR_CONNECTION_REFUSED");
    expect(data["dialogs"]).toEqual(report.dialogs);
    expect(data["downloads"]).toEqual(report.downloads);
    expect((data["throttle"] as { scale: number }).scale).toBe(4);
  });

  test("an unthrottled settle keeps the old wording", () => {
    const report = diff(VIEW, VIEW, []);
    report.unsettled = true;
    expect(renderReport(report)).toContain("(the page was still busy after 1.5 s;");
  });

  test("decorate moves the watch's findings onto the report", () => {
    const page = new WatchPage();
    page.overrides.set("Emulation.setCPUThrottlingRate", { rate: 2 });
    const watch = new NetworkWatch(page.page);
    watch.navigationError = "net::ERR_TIMED_OUT";
    const receipts = new ReceiptWatch(Object.assign(dialogPage(), { state: { autoDialog: true, listeners: [] } }));
    const report = decorate(diff(VIEW, VIEW, []), page.page, watch, receipts);
    expect(report.navigationError).toBe("net::ERR_TIMED_OUT");
    expect(report.throttle?.cpu).toBe(2);
    expect(report.settleLimit).toBe(SETTLE_LIMIT * 2);
    expect(report.dialogs).toBeUndefined();
  });

  test("an action that landed before the connection dropped is reported, not retried", async () => {
    const page = Object.assign(new WatchPage(), { url: "https://x/" });
    const watch = new NetworkWatch(page.page);
    const [report, values] = await measured(async () => landedReport(page.page, watch, "Ardia closed the connection."));
    expect(report.document).toBe("unknown");
    expect(report.error).toBe("it landed, but Ardia closed the connection, so what it changed wasn't checked (it wasn't sent again)");
    expect(values.get("action_landed_settle_lost")).toBe(true);
  });
});

describe("telemetry names", () => {
  test("every new flag and count is allowed through the upload filter", () => {
    for (const name of PRECISION_FLAGS) expect(isMetricFlag(name)).toBe(true);
    for (const name of PRECISION_COUNTS) expect(isMetricCount(name)).toBe(true);
    for (const kind of ["modal", "fixed_header", "iframe", "clipped_scroll", "overlay", "offscreen", "sibling"]) expect(PRECISION_FLAGS.has(`click_obstructed_${kind}`)).toBe(true);
  });
});

describe("review round 1", () => {
  test("a dialog dismissed within a moment still stops the action, and its input stops at once", async () => {
    const page = dialogPage();
    const sent: string[] = [];
    const action = async () => {
      sent.push("press");
      await sleep(0.4);
      sent.push("more input");
      return "done";
    };
    setTimeout(() => (page.dialog = { type: "confirm", message: "Sure?" }), 30);
    setTimeout(() => (page.dialog = null), 60);
    const error = await failure(() => raceDialog(page, action, "`click`"));
    expect(error.code).toBe("dialog_blocked");
    expect(error.message).toContain('saying "Sure?"');
    await sleep(0.5);
    expect(sent).toEqual(["press"]);
  });

  test("the opening event latches even before the page record is set", async () => {
    const page = dialogPage();
    setTimeout(() => {
      for (const listener of [...(page.state.listeners as ((p: Page | null, m: string, x: Record<string, unknown>) => void)[])]) {
        listener(page, "Page.javascriptDialogOpening", { type: "prompt", message: "Name?" });
      }
    }, 30);
    const error = await failure(() => raceDialog(page, () => sleep(5).then(() => 1), "`fill`"));
    expect((error.data?.["dialog"] as { type: string }).type).toBe("prompt");
    expect((page.state.listeners as unknown[]).length).toBe(0);
  });

  test("the action's own cleanup finishes before control returns", async () => {
    const page = dialogPage();
    const order: string[] = [];
    const action = async () => {
      try {
        await sleep(5);
      } finally {
        await shield(async () => {
          await sleep(0.15, null);
          order.push("released");
        });
      }
    };
    setTimeout(() => (page.dialog = { type: "confirm", message: "x" }), 20);
    await failure(() => raceDialog(page, action, "`click`"));
    order.push("returned");
    expect(order).toEqual(["released", "returned"]);
  });

  test("an auto-accepted alert never latches", async () => {
    const page = dialogPage();
    setTimeout(() => (page.dialog = { type: "alert", message: "Saved" }), 10);
    expect(await raceDialog(page, () => sleep(0.15).then(() => "done"), "`click`")).toBe("done");
  });

  test("the documented codes survive the JSON allowlist", () => {
    for (const code of ["dialog_blocked", "ref_drifted", "outcome_unknown", "focus_moved", "covered"]) expect(safeCode(code)).toBe(code);
  });

  test("the last keystroke isn't sent when focus moved off the field, and the message doesn't claim where the rest went", async () => {
    class MovedRenderer extends FakeRenderer {
      checks = 0;

      override async call(fn: string, args: unknown[] = []): Promise<unknown> {
        if (fn === HOLDS_FOCUS) return ++this.checks === 1;
        return super.call(fn, args);
      }

      override async send(method: string, given: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
        if (method === "Input.insertText") this.counts["input"] = (this.counts["input"] ?? 0) + 1;
        return super.send(method, given);
      }
    }
    const page = new MovedRenderer();
    const [error, values] = await measured(() => failure(() => insertThenFinalKey(page.page, new Element("F", "O", 1, "@e1"), "Lond")));
    expect(error.code).toBe("focus_moved");
    expect(error.message).toContain("Focus had moved off @e1 by the last keystroke, so that keystroke wasn't sent");
    expect(error.message).toContain("focus may have moved while it went in, so check what @e1 holds");
    expect(error.message).not.toContain("went into");
    expect(error.data).toEqual({ sent: 3 });
    expect(page.params.filter(([method]) => method === "Input.dispatchKeyEvent")).toEqual([]);
    expect(values.get("fill_focus_moved")).toBe(true);
  });

  type FakeNode = Record<string, unknown>;

  type World = { controls?: string | null; widget?: boolean; popupLabel?: string | null; id?: string };

  function popupWorld(given: World = {}) {
    const popup: FakeNode = { id: "pop", getAttribute: (name: string) => (name === "aria-labelledby" ? (given.popupLabel ?? null) : null) };
    const active: FakeNode = { tagName: "INPUT", type: "text", readOnly: false, disabled: false, isContentEditable: false, parentElement: { closest: () => popup }, getAttribute: () => null };
    const doc: FakeNode = { activeElement: active, body: {}, getElementById: (id: string) => (id === "pop" ? { contains: (node: unknown) => node === active } : null) };
    const widget: FakeNode = { contains: (node: unknown) => node === active };
    const el: FakeNode = {
      id: given.id ?? "",
      ownerDocument: doc,
      contains: () => false,
      getRootNode: () => doc,
      parentElement: { closest: () => (given.widget ? widget : null) },
      getAttribute: (name: string) => (name === "aria-controls" ? (given.controls ?? null) : name === "role" ? "combobox" : name === "aria-haspopup" ? "listbox" : null),
    };
    return { el, active };
  }

  function overlay(world: ReturnType<typeof popupWorld>): unknown {
    return (new Function(`return ${OVERLAY_INPUT}`)() as (el: unknown) => unknown)(world.el);
  }

  test("focus is followed into a popup only on explicit association with the field", () => {
    expect(overlay(popupWorld())).toBeNull();
    expect(overlay(popupWorld({ id: "picker" }))).toBeNull();
    const owned = popupWorld({ controls: "pop" });
    expect(overlay(owned)).toBe(owned.active);
    const inWidget = popupWorld({ widget: true });
    expect(overlay(inWidget)).toBe(inWidget.active);
    const labelled = popupWorld({ id: "picker", popupLabel: "picker" });
    expect(overlay(labelled)).toBe(labelled.active);
  });

  test("an unnamed container ref keeps the snapshot's generic role, and its name falls back to rendered text", async () => {
    expect(identityOf([{ nodeId: "7", ignored: false, role: { value: "group" }, name: { value: "" }, backendDOMNodeId: 7 }], 7)).toEqual({ role: "generic", name: "" });
    const page = {
      sessionFor: () => "S",
      send: async () => ({ nodes: [{ nodeId: "7", ignored: false, role: { value: "generic" }, name: { value: "" }, backendDOMNodeId: 7 }] }),
      call: async () => "Open  menu",
      state: { refs: new Map() },
    } as unknown as Page;
    await refuseDrift(page, new Element("F", "O", 7, "@e9"), { id: "e9", role: "generic", name: "Open menu", backend: 7 } as never, "click");
  });

  test("a ref that became hidden from the accessibility tree is refused, not passed", async () => {
    const page = axPage([{ nodeId: "1", ignored: true, role: { value: "button" }, backendDOMNodeId: 5 }]);
    const error = await failure(() => refuseDrift(page, new Element("F", "O", 5, "@e7"), { id: "e7", role: "button", name: "Pay", backend: 5 } as never, "click"));
    expect(error.code).toBe("ref_drifted");
    expect(error.data).toMatchObject({ field: "hidden", now: null });
    expect(error.message).toContain('button "Pay" is now hidden from the accessibility tree');
    expect(driftBetween({ role: "button", name: "x" }, null)).toBeNull();
  });

  test("a minted blocker ref carries its accessibility identity, so acting on it doesn't drift", async () => {
    const refs = new Map<string, unknown>();
    const header = new Element("F", "H", 12, "header");
    const page = {
      call: async (_fn: string, args: unknown[]) => (args[3] ? { objectId: "H" } : { ...VIEWPORT, found: true, position: "fixed", layer: { top: 0, bottom: 60, left: 0, right: 1000 }, role: "header", name: "" }),
      elementFrom: async () => header,
      sessionFor: () => "S",
      send: async () => ({ nodes: AX(12, "banner", "Site") }),
      state: {
        refs,
        knownRef: () => null,
        addRef: (_page: unknown, node: Element, role: string, name: string) => {
          refs.set("e50", { id: "e50", role, name, backend: node.backendId });
          return "e50";
        },
      },
    } as unknown as Page;
    const blocker = await findBlocker(page, new Element("F", "O", 5, "@e5"), 10, 10);
    expect(blocker?.ref).toBe("e50");
    expect(refs.get("e50")).toMatchObject({ role: "banner", name: "Site" });
    await guardDrift(page, header, "@e50", "click");
  });

  function framePage(owner: number, hit: { frameId: string; backendNodeId: number }) {
    const asked: string[] = [];
    const page = {
      session: "S",
      mainFrame: "P",
      frames: new Map([["P", { parent: null }], ["F", { parent: "P" }]]),
      sessionFor: () => "S",
      send: async (method: string) => {
        asked.push(method);
        if (method === "DOM.getNodeForLocation") return hit;
        if (method === "DOM.getFrameOwner") return { backendNodeId: owner };
        return {};
      },
    } as unknown as Page;
    return { page, asked };
  }

  test("a parent-frame overlay over an iframe target is found, paired with its own frame and node", async () => {
    const { page } = framePage(12, { frameId: "P", backendNodeId: 40 });
    const [found, values] = await measured(() => outsideItsFrame(page, new Element("F", "O", 3, "@e3"), 300, 200));
    expect(found).toEqual({ where: "the point 300,200, which isn't on it in the page around its frame", at: { frame: "P", backend: 40 } });
    expect(values.get("frame_point_unconfirmed")).toBe(true);
  });

  test("a hit on the target's own iframe element is not a cover", async () => {
    const { page, asked } = framePage(12, { frameId: "P", backendNodeId: 12 });
    expect(await outsideItsFrame(page, new Element("F", "O", 3, "@e3"), 300, 200)).toBeNull();
    expect(asked).toEqual(["DOM.getNodeForLocation", "DOM.getFrameOwner"]);
  });

  test("a blocker found in another frame is classified there, not re-probed in the child", async () => {
    const overlayNode = new Element("P", "OV", 40, "overlay");
    const probes: unknown[] = [];
    const page = {
      resolveBackend: async (backend: number, frame: string) => (backend === 40 && frame === "P" ? overlayNode : null),
      call: async (_fn: string, args: unknown[], options: { frame: string }) => {
        probes.push([options.frame, args[4] === overlayNode]);
        return args[3] ? { objectId: "OV" } : { ...VIEWPORT, found: true, position: "fixed", layer: { top: 0, bottom: 800, left: 0, right: 1000 }, role: "div", name: "" };
      },
      elementFrom: async () => overlayNode,
      sessionFor: () => "S",
      send: async () => ({ nodes: [] }),
      state: { knownRef: () => null, addRef: () => "e60" },
    } as unknown as Page;
    const blocker = await findBlocker(page, new Element("F", "O", 3, "@e3"), 10, 10, { frame: "P", backend: 40 });
    expect(blocker).toEqual({ kind: "overlay", ref: null, role: "div", name: "" });
    expect(probes).toEqual([["P", true], ["P", true]]);
  });

  test("a secret field's value never leaves the page, even after its type is toggled", () => {
    const probe = new Function(`return ${READ_FIELD}`)() as (el: unknown, latched: boolean) => Record<string, unknown>;
    const field = (type: string, autocomplete: string | null = null) => ({
      tagName: "INPUT", type, value: "hunter2", maxLength: -1, name: "", id: "", isContentEditable: false,
      getAttribute: (name: string) => (name === "autocomplete" ? autocomplete : null),
    });
    expect(probe(field("text"), true)).toMatchObject({ value: null, length: 7, secret: true });
    expect(probe(field("password"), false)).toMatchObject({ value: null, length: 7, secret: true });
    expect(probe(field("text", "one-time-code"), false)).toMatchObject({ value: null, secret: true });
    expect(probe(field("text"), false)).toMatchObject({ value: "hunter2", secret: false });
  });

  test("a secret is judged by its length alone", () => {
    const read = fieldRead({ tag: "input", type: "text", value: null, length: 7, secret: true });
    expect(judgeReadback(read, "hunter2")).toEqual({ status: "ok", kind: "password", reason: null, held: null });
    expect(judgeReadback(read, "hunter22")).toEqual({ status: "did_not_commit", kind: "password", reason: "it holds 7 characters, not 8", held: null });
    expect(judgeReadback(fieldRead({ tag: "input", value: null, secret: true }), "x").status).toBe("unverified");
    expect(secretField({ tag: "input", type: "password" })).toBe(true);
    expect(secretField({ tag: "input", type: "text" })).toBe(false);
  });

  test("a lost connection mid-action keeps its transport class but carries outcome_unknown", async () => {
    const [lost, values] = await measured(async () => refusedRetry("click", new ConnectionLost()));
    expect(lost).toBeInstanceOf(ConnectionLost);
    expect(lost).toBeInstanceOf(LostMidAction);
    expect(lost.code).toBe("outcome_unknown");
    expect(lost.exitCode).toBe(2);
    expect(safeCode(lost.code)).toBe("outcome_unknown");
    expect(values.get("retry_refusals")).toBe(1);
    expect(refusedRetry("click", lost)).toBe(lost);
    const plain = new ConnectionLost();
    expect(refusedRetry("snapshot", plain)).toBe(plain);
  });

  test("a raw throttle ends with its raw session, and the newest of raw and set wins", () => {
    const page = new WatchPage();
    let alive = true;
    noteRawThrottle(page.state, "T", "Emulation.setCPUThrottlingRate", { rate: 4 }, () => alive);
    expect(throttleOf(page.page)?.cpu).toBe(4);
    page.overrides.set("Emulation.setCPUThrottlingRate", { rate: 2 });
    noteManagedThrottle(page.page, "Emulation.setCPUThrottlingRate");
    expect(throttleOf(page.page)?.cpu).toBe(2);
    noteRawThrottle(page.state, "T", "Emulation.setCPUThrottlingRate", { rate: 6 }, () => alive);
    expect(throttleOf(page.page)?.cpu).toBe(6);
    alive = false;
    expect(throttleOf(page.page)?.cpu).toBe(2);
    page.overrides.delete("Emulation.setCPUThrottlingRate");
    expect(throttleOf(page.page)).toBeNull();
  });

  test("the in-page watch lives as long as the scaled reaction budget", () => {
    expect(reactionExpiry(1.5, 1.0)).toBe(3000);
    expect(reactionExpiry(6, 1.0)).toBe(7000);
    expect(WATCH_REACTION).toContain("(el, id, expiry)");
  });

  test("a write redirected to a read is swept like a read; an unredirected write isn't", async () => {
    const page = new WatchPage();
    const watch = new NetworkWatch(page.page);
    await watch.start();
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "r", type: "XHR", request: { method: "POST", url: "https://x/save" } });
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "r", type: "XHR", request: { method: "GET", url: "https://x/poll" }, redirectResponse: { status: 303 } });
    watch.listener(page.page, "Network.requestWillBeSent", { requestId: "w", type: "Fetch", request: { method: "POST", url: "https://x/write" } });
    const old = monotonic() - STALE_REQUEST - 0.01;
    (watch.records.get("r") as { started: number }).started = old;
    (watch.records.get("w") as { started: number }).started = old;
    expect(watch.busy()).toBe(true);
    watch.listener(page.page, "Network.loadingFinished", { requestId: "w" });
    expect(watch.busy()).toBe(false);
    await watch.stop();
  });

  test("a dialog that opens while the page settles keeps the action's result and says it landed", () => {
    expect(dialogAfterwards(new DialogBlocked({ type: "confirm", message: "Leave?" }, "`click`", true))).toBe("a JavaScript confirm dialog opened afterwards and froze the page");
    expect(dialogAfterwards(new BrowseError("x", null, "covered"))).toBeNull();
  });
});

describe("review round 2", () => {
  test("the focus check sits inside the final dispatch, after the delivery probes", async () => {
    const order: string[] = [];
    class OrderedRenderer extends FakeRenderer {
      override async call(fn: string, args: unknown[] = []): Promise<unknown> {
        if (fn === HOLDS_FOCUS) {
          order.push("focus check");
          return true;
        }
        if (fn.includes("ardiaBrowseInputWatch")) order.push("delivery probe");
        return super.call(fn, args);
      }

      override async send(method: string, given: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
        if (method === "Input.insertText") this.counts["input"] = (this.counts["input"] ?? 0) + 1;
        if (method === "Input.dispatchKeyEvent" && given?.["type"] === "keyDown") order.push("keyDown");
        return super.send(method, given);
      }
    }
    const page = new OrderedRenderer();
    await insertThenFinalKey(page.page, new Element("F", "O", 1, "@e1"), "ab");
    const keyAt = order.indexOf("keyDown");
    expect(order[keyAt - 1]).toBe("focus check");
    expect(order.slice(0, keyAt).lastIndexOf("delivery probe")).toBeLessThan(keyAt - 1);
  });

  test("every sensitive signal is latched before typing", () => {
    const probe = new Function(`return ${SECRET_PROBE}`)() as (el: unknown) => boolean;
    const field = (type: string, autocomplete: string | null) => ({ tagName: "INPUT", type, getAttribute: (name: string) => (name === "autocomplete" ? autocomplete : null) });
    expect(probe(field("password", null))).toBe(true);
    for (const word of ["current-password", "new-password", "one-time-code", "cc-csc", "cc-number"]) expect(probe(field("text", `billing ${word}`))).toBe(true);
    expect(probe(field("text", "email"))).toBe(false);
  });

  test("a latched secret is masked wherever the snapshot reads its value, after its type is toggled", async () => {
    const state = {};
    const page = {
      targetId: "T",
      loader: () => "L",
      frames: new Map([["F", { loader: "L" }]]),
      state,
      call: async () => true,
    } as unknown as Page;
    const field = new Element("F", "O", 21, "@e4");
    expect(await latchSecret(page, field, false)).toBe(true);
    const nodes = [new Node("textbox", "Password", "hunter2", new Map(), 21, [], "e4", null, null, "F"), new Node("textbox", "Email", "me@x.co", new Map(), 22, [], "e5", null, null, "F")];
    maskSecretValues(state, page, nodes);
    expect(nodes.map((node) => node.value)).toEqual(["•••••••", "me@x.co"]);
    const row = entriesOf(nodes)[0];
    expect(row?.value).toBe("•••••••");
    expect(row?.line).not.toContain("hunter2");
  });

  test("an already-open dialog refuses before the work starts", async () => {
    const page = dialogPage();
    page.dialog = { type: "confirm", message: "Discard?" };
    let started = false;
    const error = await failure(() =>
      raceDialog(page, async () => {
        started = true;
        return 1;
      }, "`click`"),
    );
    expect(started).toBe(false);
    expect(error.message).toContain("so `click` wasn't sent");
    expect((page.state.listeners as unknown[]).length).toBe(0);
  });

  test("container roles are one class, so a scoped snapshot's group matches a generic reading", () => {
    expect(sameRole({ role: "group", name: "" }, { role: "generic", name: "" })).toBe(true);
    expect(sameRole({ role: "Section", name: "" }, { role: "group", name: "" })).toBe(true);
    expect(sameRole({ role: "generic", name: "" }, { role: "button", name: "" })).toBe(false);
    expect(driftBetween({ role: "group", name: "" }, { role: "generic", name: "" })).toBeNull();
    expect(driftBetween({ role: "group", name: "" }, { role: "link", name: "" })?.field).toBe("role");
  });

  test("a blocker without an accessibility identity gets no ref rather than one the drift check can't guard", async () => {
    const added: unknown[] = [];
    const page = {
      call: async (_fn: string, args: unknown[]) => (args[3] ? { objectId: "B" } : { ...VIEWPORT, found: true, modal: true, role: "div", name: "" }),
      elementFrom: async () => new Element("F", "B", 30, "backdrop"),
      sessionFor: () => "S",
      send: async () => ({ nodes: [{ nodeId: "1", ignored: true, role: { value: "generic" }, backendDOMNodeId: 30 }] }),
      state: { knownRef: () => null, addRef: (...args: unknown[]) => (added.push(args), "e70") },
    } as unknown as Page;
    const [blocker, values] = await measured(() => findBlocker(page, new Element("F", "O", 5, "@e5"), 10, 10));
    expect(blocker).toEqual({ kind: "modal", ref: null, role: "div", name: "" });
    expect(added).toEqual([]);
    expect(values.get("click_blocker_ref")).toBeUndefined();
  });

  test("a batch result that lost the connection renders with the transport exit status", () => {
    const result = new Result({ results: [] }, "✗ lost");
    result.failed = true;
    expect(renderPlain({}, result, null)[0]).toBe(1);
    result.lost = new LostMidAction();
    expect(renderPlain({}, result, null)[0]).toBe(2);
    expect(renderPlain({ json: true }, result, null)[0]).toBe(2);
  });

  test("a raw throttle stops counting once its browser connection is replaced or closes", async () => {
    const browser = { alive: true, send: async () => ({ sessionId: "RAW1" }) };
    const state = { browser, listeners: [] as unknown[], addNotice: () => {} } as unknown as State;
    await rawSessionFor(state, "T");
    const live = liveWhile(state, "T");
    expect(live()).toBe(true);
    browser.alive = false;
    expect(live()).toBe(false);
    browser.alive = true;
    (state as unknown as { browser: unknown }).browser = { alive: true, send: browser.send };
    expect(live()).toBe(false);
  });
});

describe("a cell commit waits a fixed number of checks", () => {
  test("it checks the same number of times however slow each check is", async () => {
    let checks = 0;
    const slowCheck = async () => {
      checks += 1;
      await sleep(0.03);
      return null;
    };
    expect(await pollTimes(slowCheck, COMMIT_CHECKS)).toBeNull();
    expect(checks).toBe(COMMIT_CHECKS);
    expect(COMMIT_CHECKS).toBe(11);
    let early = 0;
    expect(await pollTimes(async () => (++early === 3 ? "closed" : null), COMMIT_CHECKS)).toBe("closed");
    expect(early).toBe(3);
  });
});

describe("review round 3", () => {
  function tab(targetId: string, loader = "L") {
    return { targetId, frames: new Map([["F", { loader }]]), loader: () => loader };
  }

  test("a field remembered as secret stays secret on the next fill even after its type is toggled", async () => {
    const state = { pages: new Map([["T", {}]]) };
    let probes = 0;
    const page = { ...tab("T"), state, call: async () => (probes++, false) } as unknown as Page;
    const field = new Element("F", "O", 21, "@e4");
    markSecret(state, tab("T"), "F", "L", 21);
    expect(await latchSecret(page, field, false)).toBe(true);
    expect(probes).toBe(0);
    const read = fieldRead({ tag: "input", type: "text", value: null, length: 7, secret: true });
    expect(judgeReadback(read, "hunter22").reason).toBe("it holds 7 characters, not 8");
  });

  test("secret markers belong to their document: navigation and closing the tab clear them, other tabs never evict them", () => {
    const state = { pages: new Map<string, unknown>([["A", {}], ["B", {}]]) };
    markSecret(state, tab("A"), "F", "L", 1);
    for (let backend = 0; backend < 2000; backend += 1) markSecret(state, tab("B"), "F", "L", backend);
    expect(isSecret(state, tab("A"), "F", "L", 1)).toBe(true);
    expect(isSecret(state, tab("A", "L2"), "F", "L2", 1)).toBe(false);
    expect(isSecret(state, tab("A"), "F", "L", 1)).toBe(false);
    markSecret(state, tab("A"), "F", "L", 1);
    state.pages.delete("A");
    expect(isSecret(state, tab("B"), "F", "L", 1999)).toBe(true);
    expect(isSecret(state, tab("A"), "F", "L", 1)).toBe(false);
  });

  test("focus is checked before the insert too, and nothing is sent when it already moved", async () => {
    class GoneRenderer extends FakeRenderer {
      override async call(fn: string, args: unknown[] = []): Promise<unknown> {
        if (fn === HOLDS_FOCUS) return false;
        return super.call(fn, args);
      }
    }
    const page = new GoneRenderer();
    const error = await failure(() => insertThenFinalKey(page.page, new Element("F", "O", 1, "@e1"), "Lond"));
    expect(error.code).toBe("focus_moved");
    expect(error.message).toContain("Focus moved off @e1 before any text was sent, so nothing was typed");
    expect(error.data).toEqual({ sent: 0 });
    expect(page.params.filter(([method]) => method.startsWith("Input."))).toEqual([]);
  });

  test("a field labelled by the opener is followed only when it sits inside a popup", () => {
    const active = { tagName: "INPUT", type: "text", readOnly: false, disabled: false, isContentEditable: false, closest: () => null, getAttribute: (name: string) => (name === "aria-labelledby" ? "picker" : null) };
    const doc = { activeElement: active, body: {}, getElementById: () => null };
    const el = { id: "picker", ownerDocument: doc, contains: () => false, getRootNode: () => doc, closest: () => null, getAttribute: () => null };
    const probe = new Function(`return ${OVERLAY_INPUT}`)() as (el: unknown) => unknown;
    expect(probe(el)).toBeNull();
    const popup = { getAttribute: () => null };
    expect(probe({ ...el, ownerDocument: { ...doc, activeElement: { ...active, parentElement: { closest: () => popup } } } })).not.toBeNull();
  });

  test("a named container changing role drifts; unnamed ones stay interchangeable", () => {
    expect(driftBetween({ role: "group", name: "Shipping" }, { role: "region", name: "Shipping" })?.field).toBe("role");
    expect(driftBetween({ role: "group", name: "Shipping" }, { role: "generic", name: "Shipping" })?.field).toBe("role");
    expect(driftBetween({ role: "group", name: "" }, { role: "generic", name: "" })).toBeNull();
    expect(sameRole({ role: "group", name: "x" }, { role: "group", name: "x" })).toBe(true);
  });
});

describe("review round 4", () => {
  const tabFor = (loader = "L") => ({ targetId: "T", frames: new Map([["F", { loader }]]) });

  test("a document past the marker cap masks every field instead of dropping old markers", () => {
    const state = { pages: new Map([["T", {}]]) };
    for (let backend = 0; backend <= SECRET_FIELDS_PER_DOCUMENT; backend += 1) markSecret(state, tabFor(), "F", "L", backend);
    expect(isSecret(state, tabFor(), "F", "L", 0)).toBe(true);
    expect(isSecret(state, tabFor(), "F", "L", 999_999)).toBe(true);
    expect(isSecret(state, tabFor("L2"), "F", "L2", 0)).toBe(false);
  });

  test("a standalone combobox input never counts as its own popup", () => {
    const self: Record<string, unknown> = { tagName: "INPUT", type: "text", readOnly: false, disabled: false, isContentEditable: false, parentElement: null, getAttribute: (name: string) => (name === "aria-labelledby" ? "picker" : name === "role" ? "combobox" : null) };
    self["closest"] = () => self;
    const doc = { activeElement: self, body: {}, getElementById: () => null };
    const el = { id: "picker", ownerDocument: doc, contains: () => false, getRootNode: () => doc, parentElement: null, closest: () => null, getAttribute: () => null };
    const probe = new Function(`return ${OVERLAY_INPUT}`)() as (el: unknown) => unknown;
    expect(probe(el)).toBeNull();
    const popup = { getAttribute: () => null };
    const inside = { ...self, parentElement: { closest: () => popup } };
    expect(probe({ ...el, ownerDocument: { ...doc, activeElement: inside } })).toBe(inside);
  });

  test("focus moved to another frame counts as moved; an unfocused top-level tab doesn't", () => {
    const probe = new Function(`return ${HOLDS_FOCUS}`)() as (el: unknown) => boolean;
    const framed = (parentActive: (owner: unknown) => unknown) => {
      const owner: Record<string, unknown> = {};
      const parentDoc = { get activeElement() { return parentActive(owner); } };
      owner["ownerDocument"] = parentDoc;
      const top = {};
      const view = { parent: top, frameElement: owner };
      (top as Record<string, unknown>)["parent"] = top;
      const doc: Record<string, unknown> = { defaultView: view, hasFocus: () => false };
      const el: Record<string, unknown> = { ownerDocument: doc, contains: () => false };
      doc["activeElement"] = el;
      return el;
    };
    expect(probe(framed((owner) => owner))).toBe(true);
    expect(probe(framed(() => ({ other: true })))).toBe(false);
    const topDoc: Record<string, unknown> = { hasFocus: () => false };
    const topView: Record<string, unknown> = {};
    topView["parent"] = topView;
    topDoc["defaultView"] = topView;
    const topEl: Record<string, unknown> = { ownerDocument: topDoc, contains: () => false };
    topDoc["activeElement"] = topEl;
    expect(probe(topEl)).toBe(true);
  });

  test("a connection lost while a latched dialog's action cleans up is rethrown, not masked", async () => {
    const page = dialogPage();
    setTimeout(() => (page.dialog = { type: "confirm", message: "Sure?" }), 20);
    const run = () => new Promise<never>((_, reject) => setTimeout(() => reject(new ConnectionLost()), 150));
    const error = await failure(() => raceDialog(page, run, "`click`"));
    expect(error).toBeInstanceOf(ConnectionLost);
    expect(refusedRetry("click", error).exitCode).toBe(2);
  });
});

describe("review round 5", () => {
  test("clearing a field aborts before Select All when focus already moved, so no other field is cleared", async () => {
    class MovedBeforeClear extends FakeRenderer {
      override async call(fn: string, args: unknown[] = []): Promise<unknown> {
        if (fn === HOLDS_FOCUS) return false;
        if (fn.includes("ardiaBrowse.info")) return { connected: true, value: "old text" };
        return super.call(fn, args);
      }
    }
    const page = new MovedBeforeClear();
    const error = await failure(() => clearField(page.page, new Element("F", "O", 1, "@e1"), false));
    expect(error.code).toBe("focus_moved");
    expect(page.params.filter(([method]) => method.startsWith("Input."))).toEqual([]);
  });

  test("a directly set field in a fully masked document returns its value masked", async () => {
    const state = { pages: new Map([["T", {}]]) };
    const frames = new Map([["F", { loader: "L" }]]);
    for (let backend = 0; backend <= SECRET_FIELDS_PER_DOCUMENT; backend += 1) markSecret(state, { targetId: "T", frames }, "F", "L", backend);
    const page = {
      targetId: "T",
      frames,
      state,
      loader: () => "L",
      focusElement: async () => {},
      call: async () => ({ set: true, stored: "2024-01-05" }),
    } as unknown as Page;
    const facts = { tag: "input", type: "date", editable: true, disabled: false };
    const [retargeted, stored, readback] = await fill(page, new Element("F", "O", 5000, "@e9"), "2024-01-05", false, null, facts);
    expect([retargeted, stored, readback]).toEqual([false, "••••••••••", null]);
    const refused = { ...page, call: async () => ({ set: false, stored: "2024-01-05" }) } as unknown as Page;
    const error = await failure(() => setValue(refused, new Element("F", "O", 5000, "@e9"), "date", "2031-01-01", true));
    expect(error.message).not.toContain("2024");
    expect(error.message).not.toContain("2031");
    expect(error.data).toEqual({ value: "••••••••••" });
  });

  test("a wrapper around a focused shadow host counts as holding focus", () => {
    const probe = new Function(`return ${HOLDS_FOCUS}`)() as (el: unknown) => boolean;
    const view: Record<string, unknown> = {};
    view["parent"] = view;
    const doc: Record<string, unknown> = { defaultView: view };
    const wrapper: Record<string, unknown> = { ownerDocument: doc, parentNode: doc };
    const host: Record<string, unknown> = { ownerDocument: doc, parentNode: wrapper };
    const shadow: Record<string, unknown> = { parentNode: null, host };
    const input: Record<string, unknown> = { parentNode: shadow };
    shadow["activeElement"] = input;
    host["shadowRoot"] = shadow;
    doc["activeElement"] = host;
    expect(probe(wrapper)).toBe(true);
    expect(probe(host)).toBe(true);
    const sibling: Record<string, unknown> = { ownerDocument: doc, parentNode: doc };
    expect(probe(sibling)).toBe(false);
  });
});
