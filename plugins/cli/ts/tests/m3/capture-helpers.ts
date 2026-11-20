import "../libc-loaded.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { browseDir, closeFd, takeLock } from "../../src/browse/paths.ts";
import type { Page } from "../../src/browse/state/page.ts";
import { State } from "../../src/browse/state/state.ts";
import { FakeBrowser, type Script, stateWith } from "./core-helpers.ts";

export const cleanups: (() => void)[] = [];

export function cleanup(): void {
  for (const run of cleanups.splice(0).reverse()) {
    try {
      run();
    } catch {}
  }
}

export function scratchDir(prefix = "ardia-d6-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export type Rig = { browser: FakeBrowser; state: State; ctx: Ctx; root: string | null };

export function rig(script: Script = () => undefined, options: { claims?: boolean; env?: Record<string, unknown>; explicit?: boolean } = {}): Rig {
  const browser = new FakeBrowser(script);
  let state = stateWith(browser, ["TARGET"], options.explicit ?? true);
  let root: string | null = null;
  if (options.claims) {
    root = scratchDir();
    const fd = browseDir(root);
    const lock = takeLock("k.lock", fd);
    cleanups.push(() => {
      closeFd(lock);
      closeFd(fd);
    });
    const plain = state;
    state = new State({ session: "s", key: "k", browseFd: fd, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
    state.browser = plain.browser;
    state.instance = plain.instance;
    state.endpoint = plain.endpoint;
    state.targetInfos = plain.targetInfos;
  }
  state.current = "TARGET";
  state.hadTab = true;
  const ctx = new Ctx(state, {}, root ?? scratchDir(), options.env ?? {}, null, "x");
  return { browser, state, ctx, root };
}

export function claimKinds(root: string): Set<string> {
  const folder = path.join(root, "Browse", "claims");
  const kinds = new Set<string>();
  if (!fs.existsSync(folder)) return kinds;
  for (const name of fs.readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    for (const kind of JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"))["kinds"] ?? []) kinds.add(kind);
  }
  return kinds;
}

export function emit(state: State, page: Page, method: string, params: Record<string, unknown>): void {
  state.onEvent(method, params, page.sessionId);
}

export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
