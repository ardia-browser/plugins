import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { linksArgs } from "../src/browse/commands/read-page.ts";
import { leadingSelector, withSelector } from "../src/browse/commands/parse.ts";
import { commandHelp } from "../src/browse/help.ts";
import { allowedFlags, splitGlobals } from "../src/browse/args.ts";
import { KNOWN_COMMANDS } from "../src/browse/tables.ts";
import { telemetrySubcommand } from "../src/telemetry.ts";

test("links [pattern] is read --links <pattern> --list, every link without one", () => {
  expect(linksArgs([])).toEqual(["--links", "*", "--list"]);
  expect(linksArgs(["docs"])).toEqual(["--links", "docs", "--list"]);
  expect(linksArgs(["--limit", "1", "main"])).toEqual(["--links", "main", "--list", "--limit", "1"]);
  expect(linksArgs(["--", "-odd"])).toEqual(["--links", "-odd", "--list"]);
  expect(() => linksArgs(["-s", "nav"])).toThrow("Unknown flag");
  expect(() => linksArgs(["nav", "--links", "main"])).toThrow("Unknown flag");
  expect(() => linksArgs(["nav", "--timeout", "5"])).toThrow("Unknown flag");
  expect(() => linksArgs(["--", "main", "unexpected"])).toThrow("links takes one pattern, not 2");
});

test("a leading -s/--selector on fill takes the selector slot, so the next word is the text", () => {
  expect(leadingSelector(["-s", "#name", "-s"])).toEqual(["#name", "-s"]);
  expect(leadingSelector(["--selector=#name", "--selector"])).toEqual(["#name", "--selector"]);
  expect(leadingSelector(["--no-humanize", "-s", "#q", "hi"])).toEqual(["--no-humanize", "#q", "hi"]);
  expect(leadingSelector(["#q", "-s"])).toEqual(["#q", "-s"]);
  expect(() => leadingSelector(["--selector="])).toThrow("needs a selector");
  expect(() => leadingSelector(["-s"])).toThrow("needs a selector");
  expect(() => leadingSelector(["-s", "--", "#name", "new"])).toThrow("needs a selector");
  expect(splitGlobals(["fill", "-s", "#name", "--json", "hello"]).rest).toEqual(["fill", "-s", "#name", "--json", "hello"]);
  expect(splitGlobals(["fill", "--selector=#name", "--json", "hello"]).rest).toEqual(["fill", "--selector=#name", "--json", "hello"]);
});

test("-s/--selector puts the selector where the command takes it", () => {
  expect(withSelector({ selector: "#a" }, ["hello"])).toEqual(["#a", "hello"]);
  expect(withSelector({ selector: "#a" }, ["attr", "href"], 1)).toEqual(["attr", "#a", "href"]);
  expect(withSelector({}, ["#b"])).toEqual(["#b"]);
  expect(() => withSelector({ selector: "" }, [])).toThrow("needs a selector");
  expect(() => withSelector({ selector: "#a" }, ["#b"], 0, 0)).toThrow("give the selector once");
  expect(withSelector({ selector: "#a" }, ["attr", "href"], 1, 1)).toEqual(["attr", "#a", "href"]);
});

test("the help gives get attr's real order and documents the guessed forms", () => {
  expect(commandHelp("get")).toContain("attr <sel> <name>");
  expect(commandHelp("get")).not.toContain("attr <name>|");
  expect(commandHelp("get")).toContain("attribute works as attr");
  expect(commandHelp("links")).toContain("read's link listing as one command");
  expect(allowedFlags("links")).toEqual(expect.arrayContaining(["--limit"]));
  expect(allowedFlags("links")).not.toContain("--links");
  expect(commandHelp("find")).toContain("--nth <n> picks match n of several");
  expect(commandHelp(undefined)).toContain("links [pattern]");
});

test("telemetry knows links and the new flags", () => {
  expect(KNOWN_COMMANDS).toContain("links");
  expect(telemetrySubcommand("browse", "links")).toBe("links");
  for (const name of ["screenshot", "get", "click", "fill"]) expect(allowedFlags(name)).toEqual(expect.arrayContaining(["-s", "--selector"]));
  expect(allowedFlags("find")).toContain("--nth");
});
