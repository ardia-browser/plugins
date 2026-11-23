import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { linksArgs, textArgs } from "../src/browse/commands/read-page.ts";
import { guessedFind } from "../src/browse/commands/find.ts";
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

test("text runs read, or get text with one selector, and names the form it ran (plugins#126)", () => {
  expect(textArgs([])).toEqual(["read", [], "text ran as `read`; ardia browse has no text command"]);
  expect(textArgs(["--nav"])).toEqual(["read", ["--nav"], "text ran as `read --nav`; ardia browse has no text command"]);
  expect(textArgs(["#price"])).toEqual(["get", ["text", "#price"], "text #price ran as `get text #price`; ardia browse has no text command"]);
  expect(textArgs(["@e12"])[0]).toBe("get");
  expect(textArgs(["https://example.com/a"])[0]).toBe("read");
  expect(textArgs(["www.example.com"])[0]).toBe("read");
  expect(textArgs(["https://a.test", "https://b.test"])[0]).toBe("read");
  expect(textArgs(["-s", "main"])).toEqual(["read", ["-s", "main"], "text ran as `read -s main`; ardia browse has no text command"]);
  expect(KNOWN_COMMANDS).toContain("text");
  expect(allowedFlags("text")).toEqual(expect.arrayContaining(["--nav", "-s", "--selector"]));
  expect(commandHelp("text")).toContain("runs `get text <selector>`");
});

test("find with a value and no locator runs find text, reading the match unless an action is given (plugins#126)", () => {
  const [one, note] = guessedFind(["agnoster"]);
  expect(one).toEqual(["text", "agnoster", "text"]);
  expect(note).toBe("find agnoster ran as `find text agnoster text`, which only reads the match; `find text agnoster` clicks it, and find takes a locator first (text, role, label, …)");
  expect(guessedFind(["Sign in", "click"])).toEqual([["text", "Sign in", "click"], 'find "Sign in" ran as `find text "Sign in" click`; find takes a locator first (text, role, label, …)']);
  for (const argv of [["text", "agnoster"], ["role", "button", "click"], ["text=agnoster"], ["first", "a"], ["agnoster", "zsh"], ["--exact", "label", "Email"]]) {
    expect(guessedFind(argv)).toEqual([argv, null]);
  }
  expect(guessedFind(["--exact", "agnoster"])).toEqual([["text", "--exact", "agnoster", "text"], expect.any(String)]);
});
