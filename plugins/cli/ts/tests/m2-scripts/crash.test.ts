import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import "../libc-loaded.ts";
import { BUILT_LIBC } from "../libc-loaded.ts";
import { consistent, repair } from "../../src/scripts/store-repair.ts";
import { Store } from "../../src/scripts/store.ts";

const SOURCE = path.resolve(import.meta.dir, "../../src");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-scripts-crash-")));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

function step(root: string, action: string, name: string, crashAt: "none" | "commitRecord" | "publishExtension"): number | null {
  const script = path.join(scratch, `step-${Math.random().toString(16).slice(2)}.ts`);
  fs.writeFileSync(
    script,
    [
      `import { loadLibc } from ${JSON.stringify(path.join(SOURCE, "libc.ts"))};`,
      `loadLibc(${JSON.stringify(BUILT_LIBC)});`,
      `const { Store } = await import(${JSON.stringify(path.join(SOURCE, "scripts/store.ts"))});`,
      `const { newMeta } = await import(${JSON.stringify(path.join(SOURCE, "scripts/userscript.ts"))});`,
      `const store = new Store(${JSON.stringify(root)});`,
      `store.open(true);`,
      crashAt === "none" ? "" : `store.${crashAt} = () => process.exit(9);`,
      `const meta = newMeta(${JSON.stringify(name)}); meta.matches = ["https://example.com/*"];`,
      action === "add"
        ? `store.apply({ meta, source: "", path: ${JSON.stringify(`/x/${name}.user.js`)}, js: ${JSON.stringify(`console.log(${JSON.stringify(name)});\n`)}, sourcemap: null, warnings: [] });`
        : `store.apply(undefined, ${JSON.stringify(name)});`,
    ].join("\n"),
  );
  const ran = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30000 });
  if (ran.status !== 0 && ran.status !== 9) process.stderr.write(ran.stderr);
  return ran.status;
}

function state(root: string): { ids: string[]; consistent: boolean; repaired: string | null } {
  const store = new Store(root);
  store.open(false);
  const ids = () => store.installed().map((meta) => meta.get("id") as string);
  const before = consistent(store, store.installed());
  const repaired = repair(store);
  assert.ok(consistent(store, store.installed()), "repair leaves the store consistent");
  return { ids: ids(), consistent: before, repaired };
}

test("a crash after the record is committed and before the extension is published is completed by the next repair", () => {
  const root = path.join(scratch, "after-record");
  fs.mkdirSync(root);
  assert.equal(step(root, "add", "one", "none"), 0);
  assert.equal(step(root, "add", "two", "publishExtension"), 9);
  const after = state(root);
  assert.deepEqual(after.ids.sort(), ["one", "two"]);
  assert.equal(after.consistent, false);
  assert.match(after.repaired ?? "", /disagreed; rebuilt/);
  assert.equal(step(root, "remove", "one", "publishExtension"), 9);
  const removed = state(root);
  assert.deepEqual(removed.ids, ["two"]);
  assert.equal(removed.consistent, false);
});

test("a crash before the record is committed leaves the previous install as it was", () => {
  const root = path.join(scratch, "before-record");
  fs.mkdirSync(root);
  assert.equal(step(root, "add", "one", "none"), 0);
  assert.equal(step(root, "add", "three", "commitRecord"), 9);
  const after = state(root);
  assert.deepEqual(after.ids, ["one"]);
  assert.equal(after.consistent, true);
});
