import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BadConfig, parseConfig } from "../../src/browse/daemon/config.ts";
import { browseDir, closeFd } from "../../src/browse/paths.ts";
import { sessionKey, sessionOwner } from "../../src/browse/request.ts";
import { MAX_SESSION_TABS, Registry, SESSION_TABS } from "../../src/browse/state/registry.ts";
import { processStart, State } from "../../src/browse/state/state.ts";
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

const RUN_1 = "4101:1:/devtools/browser/one";
const RUN_1_CONTROL_AGAIN = "4101:2:/devtools/browser/one";
const RUN_2 = "4202:1:/devtools/browser/two";

function daemon(dir: number, key: string, session: string, instance: string, owner = sessionOwner("", "token:/data", session), started = "Mon Nov 23 05:00:00 2026"): State {
  const state = new State({ session, key: key.repeat(24), owner, browseFd: dir, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  state.startOf = () => started;
  state.instance = instance;
  return state;
}

function ids(state: State): string[] {
  return [...state.registry.sessionTabs().keys()].sort();
}

function opens(state: State, target: string): void {
  state.opened.add(target);
  state.created.add(target);
}

function page(state: State, target: string, app: string): void {
  state.targetInfos.set(target, { targetId: target, url: "https://example.com/", title: "", type: "page" });
  state.appTabs.set(target, app);
}

describe("the tabs a session opened outlive its daemon and Ardia's restart", () => {
  test("a session's tabs are kept by its owner: the same across builds and daemons, apart per namespace, endpoint and plugin mode", () => {
    const { dir } = folder();
    try {
      const owner = sessionOwner("", "token:/data", "default");
      expect(owner).toMatch(/^[0-9a-f]{24}$/u);
      expect(owner).not.toBe(sessionKey("", "token:/data", "default"));
      for (const other of [sessionOwner("agent-b", "token:/data", "default"), sessionOwner("", "port:9222", "default"), sessionOwner("", "token:/data", "default", true), sessionOwner("", "token:/data", "rl")]) {
        expect(other).not.toBe(owner);
      }
      new Registry(dir, "a".repeat(24), "default", owner).updateSessionTabs(new Map([["tab-run1-4", { run: "pid:1", target: "T" }]]), []);
      expect([...new Registry(dir, "b".repeat(24), "default", owner).sessionTabs().keys()]).toEqual(["tab-run1-4"]);
      expect(new Registry(dir, "c".repeat(24), "default", sessionOwner("agent-b", "token:/data", "default")).sessionTabs().size).toBe(0);
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

  test("after Ardia restarts the session owns its restored tab again, and the user's tabs stay the user's", () => {
    const { dir } = folder();
    try {
      const before = daemon(dir, "a", "rl", RUN_1);
      opens(before, "TARGET-BEFORE");
      before.noteAppTabs(new Map([["TARGET-BEFORE", "tab-run1-4"], ["TARGET-USER-BEFORE", "tab-run1-1"]]));
      expect(ids(before)).toEqual(["tab-run1-4"]);

      const after = daemon(dir, "b", "rl", RUN_2);
      after.noteAppTabs(new Map([["TARGET-AFTER", "tab-run1-4"], ["TARGET-USER-AFTER", "tab-run1-1"]]));
      expect([...after.opened]).toEqual(["TARGET-AFTER"]);
      expect(after.registry.sessionTabs().get("tab-run1-4")).toMatchObject({ run: "pid:4202@Mon Nov 23 05:00:00 2026", target: "TARGET-AFTER" });
    } finally {
      closeFd(dir);
    }
  });

  test("a new daemon in the same Ardia run owns the same page again, and control turned off and on is still the same run", () => {
    const { dir } = folder();
    try {
      const first = daemon(dir, "a", "rl", RUN_1);
      opens(first, "TARGET");
      first.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      const next = daemon(dir, "b", "rl", RUN_1_CONTROL_AGAIN);
      next.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      expect([...next.opened]).toEqual(["TARGET"]);
    } finally {
      closeFd(dir);
    }
  });

  test("an Ardia that comes back with the same pid is still a new run, told apart by when its process started", () => {
    const { dir } = folder();
    try {
      const first = daemon(dir, "a", "rl", RUN_1, undefined, "Mon Nov 23 05:00:00 2026");
      opens(first, "TARGET-BEFORE");
      first.noteAppTabs(new Map([["TARGET-BEFORE", "tab-run1-4"]]));
      const samePid = daemon(dir, "b", "rl", RUN_1, undefined, "Mon Nov 23 06:30:00 2026");
      samePid.noteAppTabs(new Map([["TARGET-RESTORED", "tab-run1-4"]]));
      expect([...samePid.opened]).toEqual(["TARGET-RESTORED"]);
    } finally {
      closeFd(dir);
    }
  });

  test("when Ardia's start time can't be read there is no run: only the very page already recorded is taken back, nothing is written down, and the next lookup tries again", () => {
    const { dir } = folder();
    try {
      const first = daemon(dir, "a", "rl", RUN_1, undefined, "Mon Nov 23 05:00:00 2026");
      opens(first, "TARGET-SESSION");
      first.noteAppTabs(new Map([["TARGET-SESSION", "tab-run1-4"]]));
      const blind = daemon(dir, "b", "rl", RUN_1, undefined, "");
      let lookups = 0;
      let answer = "";
      blind.startOf = () => {
        lookups += 1;
        return answer;
      };
      expect(blind.run).toBe("");
      blind.noteAppTabs(new Map([["TARGET-USER-REOPENED", "tab-run1-4"]]));
      expect(blind.opened.size).toBe(0);
      blind.noteAppTabs(new Map([["TARGET-SESSION", "tab-run1-4"]]));
      expect([...blind.opened]).toEqual(["TARGET-SESSION"]);
      blind.forgetTarget("TARGET-SESSION");
      opens(blind, "TARGET-NEW");
      blind.noteAppTabs(new Map([["TARGET-NEW", "tab-run1-7"]]));
      expect(blind.registry.sessionTabs().has("tab-run1-7")).toBe(false);
      expect(blind.registry.sessionTabs().get("tab-run1-4")?.target).toBe("TARGET-SESSION");
      answer = "Mon Nov 23 05:00:00 2026";
      expect(blind.run).toBe("pid:4101@Mon Nov 23 05:00:00 2026");
      expect(lookups).toBe(5);
      expect(blind.run).toBe("pid:4101@Mon Nov 23 05:00:00 2026");
      expect(lookups).toBe(5);
      blind.noteAppTabs(new Map([["TARGET-USER-REOPENED", "tab-run1-4"], ["TARGET-NEW", "tab-run1-7"]]));
      expect([...blind.opened].sort()).toEqual(["TARGET-NEW"]);
      expect(blind.registry.sessionTabs().has("tab-run1-7")).toBe(true);
    } finally {
      closeFd(dir);
    }
  });

  test("Ardia's own process start time is read from ps, and a pid with no process gives none", () => {
    expect(processStart(process.pid)).toMatch(/[0-9]{4}$/u);
    expect(processStart(2 ** 22 + 12345)).toBe("");
  });

  test("a page the user opens in the session's tab later in the same run (a pin closed and clicked again) stays the user's", () => {
    const { dir } = folder();
    try {
      const first = daemon(dir, "a", "rl", RUN_1);
      opens(first, "TARGET-SESSION");
      first.noteAppTabs(new Map([["TARGET-SESSION", "tab-run1-4"]]));
      const next = daemon(dir, "b", "rl", RUN_1);
      next.noteAppTabs(new Map([["TARGET-USER-REOPENED", "tab-run1-4"]]));
      expect(next.opened.size).toBe(0);
      const restored = daemon(dir, "c", "rl", RUN_2);
      restored.noteAppTabs(new Map([["TARGET-RESTORED", "tab-run1-4"]]));
      expect([...restored.opened]).toEqual(["TARGET-RESTORED"]);
      const reopenedAgain = daemon(dir, "d", "rl", RUN_2);
      reopenedAgain.noteAppTabs(new Map([["TARGET-USER-AGAIN", "tab-run1-4"]]));
      expect(reopenedAgain.opened.size).toBe(0);
    } finally {
      closeFd(dir);
    }
  });

  test("a page the session only followed into its tab (a pin the user reopened) is never written down as the session's", () => {
    const { dir } = folder();
    try {
      const first = daemon(dir, "a", "rl", RUN_1);
      opens(first, "TARGET-SESSION");
      first.noteAppTabs(new Map([["TARGET-SESSION", "tab-run1-4"]]));
      first.forgetTarget("TARGET-SESSION");
      first.opened.add("TARGET-FOLLOWED");
      first.noteAppTabs(new Map([["TARGET-FOLLOWED", "tab-run1-4"]]));
      expect(first.registry.sessionTabs().get("tab-run1-4")?.target).toBe("TARGET-SESSION");
      expect(first.needsPairingBeforeClose()).toBe(true);
      const next = daemon(dir, "b", "rl", RUN_1);
      next.noteAppTabs(new Map([["TARGET-FOLLOWED", "tab-run1-4"]]));
      expect(next.opened.size).toBe(0);
    } finally {
      closeFd(dir);
    }
  });

  test("the deferred closer can read a tab's Ardia id and drop it once the close goes through", () => {
    const { dir } = folder();
    try {
      const state = daemon(dir, "a", "rl", RUN_1);
      opens(state, "TARGET");
      page(state, "TARGET", "tab-run1-4");
      state.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      const app = state.appTabOf("TARGET");
      state.forgetTarget("TARGET");
      state.dropRecorded(app);
      expect(state.registry.sessionTabs().size).toBe(0);
    } finally {
      closeFd(dir);
    }
  });

  test("a session in another namespace never owns the tab, even when it picks it by its Ardia id", () => {
    const { dir } = folder();
    try {
      const first = daemon(dir, "a", "default", RUN_1, sessionOwner("agent-a", "token:/data", "default"));
      opens(first, "TARGET");
      first.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      const second = daemon(dir, "b", "default", RUN_2, sessionOwner("agent-b", "token:/data", "default"));
      second.noteAppTabs(new Map([["TARGET-AFTER", "tab-run1-4"]]));
      expect(second.opened.size).toBe(0);
    } finally {
      closeFd(dir);
    }
  });

  test("a tab left out of a listing (a parked pin) stays the session's; a close the session made forgets it", () => {
    const { dir } = folder();
    try {
      const state = daemon(dir, "a", "rl", RUN_1);
      opens(state, "TARGET-A");
      opens(state, "TARGET-B");
      state.noteAppTabs(new Map([["TARGET-A", "tab-run1-4"], ["TARGET-B", "tab-run1-5"]]));
      state.noteAppTabs(new Map(), new Set(["tab-run1-1"]));
      expect(ids(state)).toEqual(["tab-run1-4", "tab-run1-5"]);
      state.dropRecorded("tab-run1-4");
      expect(ids(state)).toEqual(["tab-run1-5"]);
      state.dropRecorded(undefined);
      expect(ids(state)).toEqual(["tab-run1-5"]);
    } finally {
      closeFd(dir);
    }
  });

  test("a tab still listed is kept fresh, so newer tabs the user closed never push it out", () => {
    const { dir, browse } = folder();
    try {
      const state = daemon(dir, "a", "rl", RUN_1);
      opens(state, "TARGET-LIVE");
      state.noteAppTabs(new Map([["TARGET-LIVE", "tab-live-1"]]));
      const file = path.join(browse, SESSION_TABS);
      const written = JSON.parse(fs.readFileSync(file, "utf8"));
      const owner = Object.keys(written.sessions)[0] as string;
      written.sessions[owner]["tab-live-1"].at = Date.now() / 1000 - 2 * 24 * 3600;
      fs.writeFileSync(file, JSON.stringify(written));
      for (let n = 0; n < MAX_SESSION_TABS + 10; n += 1) {
        opens(state, `TARGET-${n}`);
        state.noteAppTabs(new Map([[`TARGET-${n}`, `tab-closed-${n}`]]), new Set(["tab-live-1", `tab-closed-${n}`]));
        state.opened.delete(`TARGET-${n}`);
      }
      expect(state.registry.sessionTabs().has("tab-live-1")).toBe(true);
      expect(state.registry.sessionTabs().size).toBe(MAX_SESSION_TABS);
    } finally {
      closeFd(dir);
    }
  });

  test("close looks Ardia's tabs up only when a live tab isn't recorded or a recorded one isn't paired", () => {
    const { dir } = folder();
    try {
      const state = daemon(dir, "a", "rl", RUN_1);
      expect(state.needsPairingBeforeClose()).toBe(false);
      page(state, "TARGET", "tab-run1-4");
      opens(state, "TARGET");
      expect(state.needsPairingBeforeClose()).toBe(true);
      state.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      expect(state.needsPairingBeforeClose()).toBe(false);
      state.registry.updateSessionTabs(new Map([["tab-restored-2", { run: "pid:1", target: "OLD" }]]), []);
      expect(state.needsPairingBeforeClose()).toBe(true);
    } finally {
      closeFd(dir);
    }
  });

  test("a tab counts as recorded only once its page is on disk, so a failed write is tried again", () => {
    const { dir, browse } = folder();
    try {
      const blocker = path.join(browse, SESSION_TABS);
      fs.mkdirSync(blocker);
      const state = daemon(dir, "a", "rl", RUN_1);
      opens(state, "TARGET");
      page(state, "TARGET", "tab-run1-4");
      state.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      expect(state.recorded("TARGET")).toBe(false);
      fs.rmdirSync(blocker);
      state.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      expect(state.recorded("TARGET")).toBe(true);
    } finally {
      closeFd(dir);
    }
  });

  test("a tab the session created stays due for a lookup until its page is on disk, however long that takes", () => {
    const { dir, browse } = folder();
    try {
      const blocker = path.join(browse, SESSION_TABS);
      fs.mkdirSync(blocker);
      const state = daemon(dir, "a", "rl", RUN_1);
      opens(state, "TARGET");
      page(state, "TARGET", "tab-run1-4");
      state.opened.add("TARGET-FOLLOWED");
      page(state, "TARGET-FOLLOWED", "tab-run1-9");
      expect(state.unrecordedCreated()).toEqual(["TARGET"]);
      for (let attempt = 0; attempt < 10; attempt += 1) state.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      expect(state.unrecordedCreated()).toEqual(["TARGET"]);
      fs.rmdirSync(blocker);
      state.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      expect(state.unrecordedCreated()).toEqual([]);
      const next = daemon(dir, "b", "rl", RUN_1);
      opens(next, "TARGET");
      page(next, "TARGET", "tab-run1-4");
      next.noteAppTabs(new Map([["TARGET", "tab-run1-4"]]));
      expect(next.unrecordedCreated()).toEqual([]);
    } finally {
      closeFd(dir);
    }
  });

  test("entries older than three days lapse, an owner keeps its newest tabs, and a damaged file starts over", () => {
    const { dir, browse } = folder();
    try {
      const owner = "f".repeat(24);
      const registry = new Registry(dir, "a".repeat(24), "rl", owner);
      registry.updateSessionTabs(new Map([["tab-fresh-1", { run: "pid:1", target: "T" }]]), []);
      const file = path.join(browse, SESSION_TABS);
      const written = JSON.parse(fs.readFileSync(file, "utf8"));
      const old = Date.now() / 1000 - 4 * 24 * 3600;
      written.sessions[owner]["tab-old-1"] = { run: "pid:1", target: "OLD", at: old };
      written.sessions.gone = { "tab-old-2": { run: "pid:1", target: "OLD", at: old } };
      fs.writeFileSync(file, JSON.stringify(written));
      expect([...registry.sessionTabs().keys()]).toEqual(["tab-fresh-1"]);
      registry.updateSessionTabs(new Map(Array.from({ length: MAX_SESSION_TABS + 5 }, (_, n) => [`tab-many-${n}`, { run: "pid:1", target: `T${n}` }])), []);
      expect(registry.sessionTabs().size).toBe(MAX_SESSION_TABS);
      expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).sessions)).toEqual([owner]);
      fs.writeFileSync(file, "{not json");
      expect(registry.sessionTabs().size).toBe(0);
      registry.updateSessionTabs(new Map([["tab-again-1", { run: "pid:1", target: "T" }]]), []);
      expect([...registry.sessionTabs().keys()]).toEqual(["tab-again-1"]);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      closeFd(dir);
    }
  });

  test("a record that can't be read or written never breaks the command that pairs tabs", () => {
    const { dir, browse } = folder();
    try {
      fs.mkdirSync(path.join(browse, SESSION_TABS));
      const state = daemon(dir, "a", "rl", RUN_1);
      opens(state, "TARGET");
      expect(() => state.noteAppTabs(new Map([["TARGET", "tab-run1-4"], ["OTHER", "tab-run1-1"]]), new Set(["tab-run1-1", "tab-run1-4"]))).not.toThrow();
      expect(state.ownsSessionTabs()).toBe(false);
      expect([...state.opened]).toEqual(["TARGET"]);
    } finally {
      closeFd(dir);
    }
  });
});
