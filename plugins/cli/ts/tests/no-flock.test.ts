import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-no-flock-")));
for (const name of ["home", "cli-home", "data"]) fs.mkdirSync(path.join(scratch, name), { mode: 0o700 });
fs.mkdirSync(path.join(scratch, "data", "Telemetry"), { mode: 0o700 });
fs.writeFileSync(path.join(scratch, "data", "telemetry.json"), JSON.stringify({ sharing: true, installId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }));
process.env.HOME = path.join(scratch, "home");
process.env.ARDIA_CLI_HOME = path.join(scratch, "cli-home");
process.env.ARDIA_DATA_DIR = path.join(scratch, "data");

function everything(): string[] {
  return fs.readdirSync(scratch, { recursive: true, encoding: "utf8" }).sort();
}

test("the flock flag comes from the platform, never a guess", async () => {
  const { flockOpenFlag } = await import("../src/privatefs.ts");
  assert.equal(flockOpenFlag("darwin", {}), 0x20);
  assert.equal(flockOpenFlag("linux", {}), undefined);
  assert.equal(flockOpenFlag("linux", { O_EXLOCK: 0x20 }), 0x20);
});

function pretendingToBe<T>(platform: string, work: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return work().finally(() => {
    if (real !== undefined) Object.defineProperty(process, "platform", real);
  });
}

test("without the flock flag, help and listings go back to Python before anything is written", () =>
  pretendingToBe("linux", async () => {
    const { locksLikePython, takeLock, NoFlock, openPrivate } = await import("../src/privatefs.ts");
    const { serveHelp, serveListing } = await import("../src/serve.ts");
    const { emptyListing } = await import("../src/listing.ts");
    assert.equal(locksLikePython(), false);
    const before = everything();
    assert.equal(serveHelp(["--help"], null), undefined);
    assert.equal(await serveListing("windows", emptyListing(), ["windows"], null), undefined);
    assert.deepEqual(everything(), before);
    const dir = openPrivate(path.join(scratch, "data"), ["Telemetry"], false);
    assert.throws(() => takeLock("cli-queue.lock", dir), NoFlock);
    assert.deepEqual(everything(), before);
    fs.rmSync(scratch, { recursive: true, force: true });
  }));
