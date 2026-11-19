import assert from "node:assert/strict";
import { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { connectAt, socketInfoAt } from "../src/libc.ts";
import { checkSocket } from "../src/browse/session.ts";

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

test("the session socket is checked and reached through the same held folder, by a bare name only", async () => {
  const box = mkdtempSync(path.join(tmpdir(), "sockat-"));
  const held = path.join(box, "Browse");
  mkdirSync(held, { mode: 0o700 });
  const server = createServer((connection) => connection.end("hello\n"));
  await new Promise<void>((resolve) => server.listen(path.join(held, "k.sock"), resolve));
  chmodSync(path.join(held, "k.sock"), 0o600);
  const fd = openSync(held, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    renameSync(held, path.join(box, "moved"));
    mkdirSync(held, { mode: 0o700 });
    writeFileSync(path.join(held, "k.sock"), "not a socket");
    assert.doesNotThrow(() => checkSocket({ fd }, "k.sock"));
    const connected = connectAt(fd, "k.sock", 1000);
    closeSync(connected);
    for (const name of ["a/k.sock", ".", "..", "../moved/k.sock"]) {
      assert.equal(codeOf(() => connectAt(fd, name, 1000)), "EINVAL", name);
      assert.equal(codeOf(() => socketInfoAt(fd, name)), "EINVAL", name);
    }
    chmodSync(path.join(box, "moved", "k.sock"), 0o644);
    assert.throws(() => checkSocket({ fd }, "k.sock"), /must be mode 0600/);
  } finally {
    closeSync(fd);
    server.close();
    rmSync(box, { recursive: true, force: true });
  }
});
