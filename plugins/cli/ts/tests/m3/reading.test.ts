import { describe, expect, test } from "bun:test";
import { Result } from "../../src/browse/daemon/render.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { dispatch, hooks } from "../../src/browse/commands/all.ts";
import { noteReading, PAGE_BY_PAGE_HINT, readsPage } from "../../src/browse/commands/reading.ts";
import { type State } from "../../src/browse/state/state.ts";
import { FakeBrowser, stateWith } from "./core-helpers.ts";

const page = new Result({ url: "http://x/" }, "http://x/");

function run(state: State, steps: [string, string[], Result?][]): void {
  for (const [name, argv, result] of steps) noteReading(state, name, argv, result ?? page);
}

function hints(state: State): number {
  return (state.notice ?? "").split("\n").filter((line) => line === PAGE_BY_PAGE_HINT).length;
}

describe("the page-by-page reading hint", () => {
  test("reads_page takes get text, get html and read without addresses only", () => {
    expect(readsPage("get", ["text"])).toBe(true);
    expect(readsPage("get", ["html", "main"])).toBe(true);
    expect(readsPage("get", ["title"])).toBe(false);
    expect(readsPage("get", [])).toBe(false);
    expect(readsPage("read", [])).toBe(true);
    expect(readsPage("read", ["--full"])).toBe(true);
    expect(readsPage("read", ["https://a/"])).toBe(false);
  });

  test("the third page read after arriving gives the hint once, and back and forward count as arriving", () => {
    const state = stateWith(new FakeBrowser());
    run(state, [
      ["open", ["http://a/"]],
      ["get", ["text"]],
      ["tab", ["list"]],
      ["back", []],
      ["read", []],
      ["forward", []],
    ]);
    expect(hints(state)).toBe(0);
    run(state, [["get", ["html"]]]);
    expect(hints(state)).toBe(1);
    run(state, [
      ["open", ["http://d/"]],
      ["read", []],
    ]);
    expect(hints(state)).toBe(1);
  });

  test("open without an address doesn't arrive, a second read on the same page doesn't count, and a new document from any command does", () => {
    const state = stateWith(new FakeBrowser());
    const navigated = new Result({ changes: { document: "new" } });
    run(state, [
      ["open", ["--show"]],
      ["read", []],
      ["open", ["http://a/"]],
      ["read", []],
      ["read", []],
      ["click", ["@e1"], navigated],
      ["read", []],
    ]);
    expect(hints(state)).toBe(0);
    run(state, [
      ["back", []],
      ["get", ["text"]],
    ]);
    expect(hints(state)).toBe(1);
  });

  test("any command outside the read-only set ends the streak", () => {
    const state = stateWith(new FakeBrowser());
    run(state, [
      ["open", ["http://a/"]],
      ["read", []],
      ["open", ["http://b/"]],
      ["read", []],
      ["fill", ["@e1", "x"]],
      ["open", ["http://c/"]],
      ["read", []],
    ]);
    expect(hints(state)).toBe(0);
  });

  test("dispatch runs the hook after a command, never inside a script or for batch", async () => {
    expect(hooks.after).toBeDefined();
    const state = stateWith(new FakeBrowser());
    state.current = "TARGET";
    const ctx = (name: string) => new Ctx(state, {}, "/", {}, null, name);
    for (let round = 0; round < 3; round += 1) {
      await dispatch(ctx("back"), "back", []);
      noteReading(state, "read", [], page);
    }
    expect(hints(state)).toBe(1);
    const scripted = stateWith(new FakeBrowser());
    scripted.current = "TARGET";
    scripted.topCommand = "script";
    for (let round = 0; round < 3; round += 1) {
      await dispatch(new Ctx(scripted, {}, "/", {}, null, "back"), "back", []);
      noteReading(scripted, "read", [], page);
    }
    expect(hints(scripted)).toBe(0);
  });
});
