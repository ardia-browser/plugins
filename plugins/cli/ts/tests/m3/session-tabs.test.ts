import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { browseDir, closeFd } from "../../src/browse/paths.ts";
import { MAX_SESSION_TABS, Registry, SESSION_TABS } from "../../src/browse/state/registry.ts";
import { State } from "../../src/browse/state/state.ts";
import { type Scratch, scratch } from "./daemon-helpers.ts";

const made: Scratch[] = [];
afterAll(() => {
  for (const found of made) found.done();
});

function folder(): { dir: number; browse: string } {
  const found = scratch();
  made.push(found);
  return { dir: browseDir(found.data), browse: found.browse };
}

function daemon(dir: number, key: string, session: string, instance: string): State {
  const state = new State({ session, key: key.repeat(24), browseFd: dir, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  state.instance = instance;
  return state;
}

describe("the tabs a session opened outlive its daemon and Ardia's restart", () => {
  test("a session's app tabs are kept per session name, whatever the daemon key", () => {
    const { dir } = folder();
    try {
      new Registry(dir, "a".repeat(24), "rl").updateSessionTabs(["tab-run1-4"], []);
      expect([...new Registry(dir, "b".repeat(24), "rl").sessionTabs()]).toEqual(["tab-run1-4"]);
      expect(new Registry(dir, "c".repeat(24), "other").sessionTabs().size).toBe(0);
    } finally {
      closeFd(dir);
    }
  });

  test("after a relaunch the session owns its restored tab again, and the user's tabs stay the user's", () => {
    const { dir } = folder();
    try {
      const before = daemon(dir, "a", "rl", "instance-1");
      before.opened.add("TARGET-BEFORE");
      before.noteAppTabs(new Map([["TARGET-BEFORE", "tab-run1-4"], ["TARGET-USER-BEFORE", "tab-run1-1"]]), new Set(["tab-run1-1", "tab-run1-4"]));
      expect([...before.registry.sessionTabs()]).toEqual(["tab-run1-4"]);

      const after = daemon(dir, "b", "rl", "instance-2");
      expect(after.opened.size).toBe(0);
      after.noteAppTabs(new Map([["TARGET-AFTER", "tab-run1-4"], ["TARGET-USER-AFTER", "tab-run1-1"]]), new Set(["tab-run1-1", "tab-run1-4"]));
      expect([...after.opened]).toEqual(["TARGET-AFTER"]);

      const someoneElse = daemon(dir, "c", "other", "instance-2");
      someoneElse.noteAppTabs(new Map([["TARGET-AFTER", "tab-run1-4"]]), null);
      expect(someoneElse.opened.size).toBe(0);
    } finally {
      closeFd(dir);
    }
  });

  test("a tab Ardia no longer lists is forgotten, a partial lookup forgets nothing, and closing the session forgets them all", () => {
    const { dir } = folder();
    try {
      const state = daemon(dir, "a", "rl", "instance-1");
      state.registry.updateSessionTabs(["tab-run1-4", "tab-run1-5"], []);
      state.noteAppTabs(new Map(), null);
      expect(state.registry.sessionTabs().size).toBe(2);
      state.noteAppTabs(new Map(), new Set(["tab-run1-5", "tab-run1-1"]));
      expect([...state.registry.sessionTabs()]).toEqual(["tab-run1-5"]);
      state.forgetSessionTabs();
      expect(state.registry.sessionTabs().size).toBe(0);
      expect(state.ownsSessionTabs()).toBe(false);
    } finally {
      closeFd(dir);
    }
  });

  test("entries older than three days lapse, a session keeps its newest tabs, and a damaged file starts over", () => {
    const { dir, browse } = folder();
    try {
      const registry = new Registry(dir, "a".repeat(24), "rl");
      registry.updateSessionTabs(["tab-fresh-1"], []);
      const file = path.join(browse, SESSION_TABS);
      const written = JSON.parse(fs.readFileSync(file, "utf8"));
      written.sessions.rl["tab-old-1"] = Date.now() / 1000 - 4 * 24 * 3600;
      written.sessions.gone = { "tab-old-2": Date.now() / 1000 - 4 * 24 * 3600 };
      fs.writeFileSync(file, JSON.stringify(written));
      expect([...registry.sessionTabs()]).toEqual(["tab-fresh-1"]);
      registry.updateSessionTabs(Array.from({ length: MAX_SESSION_TABS + 5 }, (_, n) => `tab-many-${n}`), []);
      expect(registry.sessionTabs().size).toBe(MAX_SESSION_TABS);
      expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).sessions)).toEqual(["rl"]);
      fs.writeFileSync(file, "{not json");
      expect(registry.sessionTabs().size).toBe(0);
      registry.updateSessionTabs(["tab-again-1"], []);
      expect([...registry.sessionTabs()]).toEqual(["tab-again-1"]);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      closeFd(dir);
    }
  });
});
