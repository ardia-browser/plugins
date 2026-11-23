import { expect, test } from "bun:test";
import { parseText, type Value } from "../src/json.ts";
import { decorateFailure } from "../src/browse/answer-codes.ts";
import { unknownCommand } from "../src/browse/commands/index.ts";
import { parse } from "../src/browse/commands/parse.ts";
import { Usage } from "../src/browse/daemon-errors.ts";
import { BrowseError } from "../src/browse/errors.ts";
import { renderError } from "../src/browse/render.ts";
import { inferredCode, remedyFor, tagged } from "../src/browse/remedies.ts";
import { closest, editDistance } from "../src/browse/suggest.ts";
import { Secrets } from "../src/redact.ts";
import { TELEMETRY_ERROR_CODES } from "../src/telemetry-schema.ts";
import { ERROR_CODES } from "../src/browse/remedies.ts";

function answer(fields: [string, Value][]): Map<string, Value> {
  return new Map(fields);
}

test("did-you-mean takes the closest name within a few edits, else none", () => {
  expect(editDistance("clik", "click")).toBe(1);
  expect(editDistance("snpashot", "snapshot")).toBe(1);
  expect(closest("clik", ["click", "close", "check"])).toBe("click");
  expect(closest("--fliter", ["--filter", "--fields"])).toBe("--filter");
  expect(closest("--interactiv", ["--interactive", "-i"])).toBe("--interactive");
  expect(closest("zzzzzz", ["click", "close"])).toBeUndefined();
  expect(closest("click", ["click"])).toBeUndefined();
});

test("an unknown flag and an unknown command name the closest one", () => {
  expect(() => parse(["--clera"], { "--clear": "bool" })).toThrow("Unknown flag: --clera. Did you mean --clear?");
  expect(() => parse(["--zzzz"], { "--clear": "bool" })).toThrow(/^Unknown flag: --zzzz$/u);
  expect(unknownCommand("clik").message).toBe("Unknown command: clik. Did you mean `ardia browse click`? Run `ardia browse --help` for the rest");
  expect(unknownCommand("qqqqqqq").message).toBe("Unknown command: qqqqqqq. Run `ardia browse --help`");
  expect(unknownCommand("clik")).toBeInstanceOf(Usage);
});

test("codes come from the answer, or from the message for usage errors the daemon leaves uncoded", () => {
  expect(inferredCode("stale_ref", "✗ Stale ref")).toBe("stale_ref");
  expect(inferredCode("command_failed", "✗ Unknown command: clik")).toBe("unknown_command");
  expect(inferredCode(undefined, "Usage: ardia browse pushstate <url>")).toBe("usage");
  expect(inferredCode(undefined, "something else")).toBeUndefined();
  expect(remedyFor("usage", "pushstate")).toBe("ardia browse pushstate --help");
  expect(remedyFor("usage", "goto")).toBe("ardia browse open --help");
  expect(remedyFor("usage", "nonsense")).toBe("ardia browse --help");
  expect(remedyFor("navigation_failed")).toBeUndefined();
  expect(tagged("Stale ref @e5", "stale_ref")).toBe("Stale ref @e5 (stale_ref)");
  expect(tagged("Stale ref @e5 (stale_ref)", "stale_ref")).toBe("Stale ref @e5 (stale_ref)");
  expect(tagged("failed", "command_failed")).toBe("failed");
});

test("every documented code is one telemetry records as itself", () => {
  const clientOnly = new Set(["daemon_timeout", "daemon_unreachable", "unknown_command", "usage_error"]);
  for (const code of Object.keys(ERROR_CODES)) if (!clientOnly.has(code)) expect(TELEMETRY_ERROR_CODES.has(code), code).toBe(true);
});

test("a text failure gets its code and remedy; a --json one gets a remedy key", () => {
  const text = answer([["exit", 1n], ["out", ""], ["err", "→ a notice\n✗ Stale ref @e5: the page changed. Run `ardia browse snapshot -i` again\n"], ["code", "stale_ref"]]);
  expect(decorateFailure(text, "click")).toBe(true);
  expect(text.get("err")).toBe("→ a notice\n✗ Stale ref @e5: the page changed. Run `ardia browse snapshot -i` again (stale_ref)\n  remedy: ardia browse snapshot -i\n");
  const json = answer([["exit", 1n], ["out", '{"success":false,"data":null,"error":"Usage: ardia browse pushstate <url>","code":"command_failed"}\n'], ["err", ""]]);
  expect(decorateFailure(json, "pushstate")).toBe(true);
  const parsed = parseText((json.get("out") as string).trim()) as Map<string, Value>;
  expect(parsed.get("remedy")).toBe("ardia browse pushstate --help");
  expect(parsed.get("code")).toBe("command_failed");
  const plain = answer([["exit", 1n], ["out", ""], ["err", "✗ Navigation to x failed\n"], ["code", "navigation_failed"]]);
  expect(decorateFailure(plain, "open")).toBe(false);
  expect(plain.get("err")).toBe("✗ Navigation to x failed (navigation_failed)\n");
  const fine = answer([["exit", 0n], ["out", "ok\n"], ["err", ""]]);
  expect(decorateFailure(fine, "open")).toBe(false);
  expect(fine.get("out")).toBe("ok\n");
});

test("client-side failures carry the code and remedy too", () => {
  const error = new BrowseError("the ardia browse daemon closed the connection", 2, undefined, "daemon_unreachable");
  expect(renderError(error, false, new Secrets()).err).toBe("✗ the ardia browse daemon closed the connection (daemon_unreachable)\n  remedy: ardia browse session list\n");
  const shown = parseText(renderError(error, true, new Secrets()).out.trim()) as Map<string, Value>;
  expect(shown.get("code")).toBe("daemon_unreachable");
  expect(shown.get("remedy")).toBe("ardia browse session list");
});
