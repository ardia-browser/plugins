import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BadConfig, parseConfig } from "../../src/browse/daemon/config.ts";
import { browseDir, closeFd } from "../../src/browse/paths.ts";
import { sessionKey, sessionOwner } from "../../src/browse/request.ts";
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

function daemon(dir: number, key: string, session: string, instance: string, owner = sessionOwner("", "token:/data", session)): State {
  const state = new State({ session, key: key.repeat(24), owner, browseFd: dir, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  state.instance = instance;
  return state;
}

describe("the tabs a session opened outlive its daemon and Ardia's restart", () => {
  test("a session's app tabs are kept by its owner, the same across builds and daemons, and apart per namespace, endpoint and plugin mode", () => {
    const { dir } = folder();
    try {
      const owner = sessionOwner("", "token:/data", "default");
      expect(owner).toMatch(/^[0-9a-f]{24}$/u);
      expect(owner).not.toBe(sessionKey("", "token:/data", "default"));
      for (const other of [sessionOwner("agent-b", "token:/data", "default"), sessionOwner("", "port:9222", "default"), sessionOwner("", "token:/data", "default", true), sessionOwner("", "token:/data", "rl")]) {
        expect(other).not.toBe(owner);
      }
      new Registry(dir, "a".repeat(24), "default", owner).updateSessionTabs(["tab-run1-4"], []);
      expect([...new Registry(dir, "b".repeat(24), "default", owner).sessionTabs()]).toEqual(["tab-run1-4"]);
      expect(new Registry(dir, "c".repeat(24), "default", sessionOwner("agent-b", "token:/data", "default")).sessionTabs().size).toBe(0);
    } finally {
      closeFd(dir);
    }
  });

  test("a session in another namespace never owns the tab, even when it picks it by its Ardia id", () => {
    const { dir } = folder();
    try {
      const first = daemon(dir, "a", "default", "instance-1", sessionOwner("agent-a", "token:/data", "default"));
      first.opened.add("TARGET");
      first.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]), null);
      const second = daemon(dir, "b", "default", "instance-1", sessionOwner("agent-b", "token:/data", "default"));
      second.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]), null);
      expect(second.opened.size).toBe(0);
    } finally {
      closeFd(dir);
    }
  });

  test("the daemon config carries the owner, and a config without one owns only by its own key", () => {
    const base = { session: "default", key: "a".repeat(24), data_root: "/data" };
    expect(parseConfig(JSON.stringify({ ...base, owner: "b".repeat(24) })).owner).toBe("b".repeat(24));
    expect(parseConfig(JSON.stringify(base)).owner).toBe("a".repeat(24));
    expect(() => parseConfig(JSON.stringify({ ...base, owner: "../x" }))).toThrow(BadConfig);
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

  test("a tab Ardia no longer lists is forgotten and a partial lookup forgets nothing", () => {
    const { dir } = folder();
    try {
      const state = daemon(dir, "a", "rl", "instance-1");
      state.registry.updateSessionTabs(["tab-run1-4", "tab-run1-5"], []);
      state.noteAppTabs(new Map(), null);
      expect(state.registry.sessionTabs().size).toBe(2);
      state.noteAppTabs(new Map(), new Set(["tab-run1-5", "tab-run1-1"]));
      expect([...state.registry.sessionTabs()]).toEqual(["tab-run1-5"]);
      expect(state.ownsSessionTabs()).toBe(true);
    } finally {
      closeFd(dir);
    }
  });

  test("entries older than three days lapse, a session keeps its newest tabs, and a damaged file starts over", () => {
    const { dir, browse } = folder();
    try {
      const owner = "f".repeat(24);
      const registry = new Registry(dir, "a".repeat(24), "rl", owner);
      registry.updateSessionTabs(["tab-fresh-1"], []);
      const file = path.join(browse, SESSION_TABS);
      const written = JSON.parse(fs.readFileSync(file, "utf8"));
      written.sessions[owner]["tab-old-1"] = Date.now() / 1000 - 4 * 24 * 3600;
      written.sessions.gone = { "tab-old-2": Date.now() / 1000 - 4 * 24 * 3600 };
      fs.writeFileSync(file, JSON.stringify(written));
      expect([...registry.sessionTabs()]).toEqual(["tab-fresh-1"]);
      registry.updateSessionTabs(Array.from({ length: MAX_SESSION_TABS + 5 }, (_, n) => `tab-many-${n}`), []);
      expect(registry.sessionTabs().size).toBe(MAX_SESSION_TABS);
      expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).sessions)).toEqual([owner]);
      fs.writeFileSync(file, "{not json");
      expect(registry.sessionTabs().size).toBe(0);
      registry.updateSessionTabs(["tab-again-1"], []);
      expect([...registry.sessionTabs()]).toEqual(["tab-again-1"]);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      closeFd(dir);
    }
  });

  test("a record that can't be read or written never breaks the command that pairs tabs", () => {
    const { dir, browse } = folder();
    try {
      fs.mkdirSync(path.join(browse, SESSION_TABS));
      const state = daemon(dir, "a", "rl", "instance-1");
      state.opened.add("TARGET");
      expect(() => state.noteAppTabs(new Map([["TARGET", "tab-run1-4"], ["OTHER", "tab-run1-1"]]), new Set(["tab-run1-1", "tab-run1-4"]))).not.toThrow();
      expect(state.ownsSessionTabs()).toBe(false);
      expect([...state.opened]).toEqual(["TARGET"]);
    } finally {
      closeFd(dir);
    }
  });
});
