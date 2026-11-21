import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentOf, ancestry, bundleName, cleanName, FALLBACK, fromChain, outerBundle, procArgs, type Process } from "../src/caller.ts";
import { libcBeside, loadLibc } from "../src/libc.ts";
import { topLevelString } from "../src/plist.ts";

function process(path: string, argv: string[]): Process {
  return { pid: 10, ppid: 1, path, argv };
}

test("finds agents as caller.rs does", () => {
  assert.equal(agentOf(process("/Users/x/.local/share/claude/versions/2.1.0", ["claude"])), "Claude Code");
  assert.equal(agentOf(process("/opt/homebrew/bin/node", ["node", "/usr/local/bin/codex.js"])), "Codex");
  assert.equal(agentOf(process("/usr/bin/python3.12", ["python3.12", "-m", "aider"])), undefined);
  assert.equal(agentOf(process("/bin/zsh", ["-zsh"])), undefined);
  assert.equal(agentOf(process("/x/bun1.3", ["bun1.3", "/tmp/Gemini.TS"])), "Gemini CLI");
  assert.equal(agentOf(process("/x/pythonx", ["pythonx", "/tmp/codex.py"])), undefined);
});

test("names the outer bundle", () => {
  assert.equal(outerBundle("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"), "/Applications/Visual Studio Code.app");
  assert.equal(outerBundle("/usr/bin/ssh"), undefined);
  assert.equal(outerBundle("rel/./X.app/Contents/MacOS/x"), "rel/X.app");
  assert.equal(outerBundle("/.app/Contents/x"), undefined);
  const chain = [process("/bin/zsh", ["zsh"]), process("/Applications/Ghostty.app/Contents/MacOS/ghostty", ["ghostty"])];
  assert.deepEqual(fromChain(chain, () => "Ghostty"), { name: "Ghostty", app: "/Applications/Ghostty.app" });
  assert.equal(fromChain(chain.slice(0, 1), () => undefined).name, FALLBACK);
  assert.deepEqual(fromChain([process(`/${"a".repeat(1030)}.app/Contents/MacOS/x`, [])], () => "Long"), { name: "Long" });
});

test("cleans names", () => {
  assert.equal(cleanName("  Visual​ Studio\tCode\u0000 "), "Visual Studio Code");
  assert.equal(cleanName("x".repeat(50))?.length, 40);
  assert.equal(cleanName("​"), undefined);
  assert.equal(cleanName("a﻿b\u0085c"), "ab c");
  assert.equal(cleanName(`${"😀".repeat(39)} b`), "😀".repeat(39));
});

test("reads XML plists", () => {
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleURLTypes</key><array><dict><key>CFBundleName</key><string>Inner</string></dict></array>
  <key>CFBundleDisplayName</key><string/>
  <key>LSMinimumSystemVersion</key><string>13</string>
  <key>CFBundleName</key><string>Tom &amp; Jerry&#x2122;&#+65;&#xD800;</string>
</dict></plist>`;
  const raw = Buffer.from(text);
  assert.equal(topLevelString(raw, "CFBundleName"), "Tom & Jerry™A&#xD800;");
  assert.equal(topLevelString(raw, "CFBundleDisplayName"), "");
  assert.equal(topLevelString(raw, "Missing"), undefined);
  assert.equal(topLevelString(Buffer.from([0x3c, 0xff]), "x"), undefined);
});

test("reads binary plists", () => {
  const parts: number[] = [...Buffer.from("bplist00")];
  const offsets: number[] = [];
  offsets.push(parts.length);
  parts.push(0xd2, 1, 2, 3, 4);
  offsets.push(parts.length);
  parts.push(0x5b, ...Buffer.from("CFBundleKey"));
  offsets.push(parts.length);
  parts.push(0x5c, ...Buffer.from("CFBundleName"));
  offsets.push(parts.length);
  parts.push(0x53, ...Buffer.from("one"));
  offsets.push(parts.length);
  parts.push(0x62, 0x00, 0x54, 0x00, 0xe9);
  const table = parts.length;
  parts.push(...offsets);
  parts.push(0, 0, 0, 0, 0, 0, 1, 1);
  const word = (value: number) => [0, 0, 0, 0, 0, 0, 0, value];
  parts.push(...word(offsets.length), ...word(0), ...word(table));
  const raw = Buffer.from(parts);
  assert.equal(topLevelString(raw, "CFBundleName"), "Té");
  assert.equal(topLevelString(raw, "CFBundleKey"), "one");
  assert.equal(topLevelString(raw.subarray(0, 39), "CFBundleName"), undefined);
});

test("splits KERN_PROCARGS2 as caller.rs does", () => {
  const args = (argc: number, body: string) => Buffer.concat([Buffer.from(Int32Array.of(argc).buffer), Buffer.from(body, "latin1")]);
  assert.deepEqual(procArgs(args(3, "/bin/zsh\0\0\0zsh\0-c\0x\0")), ["zsh", "-c"]);
  assert.deepEqual(procArgs(args(1, "/bin/zsh\0\0zsh\0")), ["zsh"]);
  assert.deepEqual(procArgs(args(2, "/p\0a\0\0b")), ["a", ""]);
  assert.deepEqual(procArgs(args(2, "/p\0")), [""]);
  assert.deepEqual(procArgs(args(-1, "/p\0a\0")), []);
  assert.deepEqual(procArgs(args(2, "/p")), []);
  assert.deepEqual(procArgs(Buffer.from([1, 0])), []);
});

test("names a bundle from its Info.plist, else its folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "caller-"));
  try {
    const named = join(dir, "Named.app");
    mkdirSync(join(named, "Contents"), { recursive: true });
    writeFileSync(join(named, "Contents", "Info.plist"), "<plist><dict><key>CFBundleDisplayName</key><string>​</string><key>CFBundleName</key><string>Shown</string></dict></plist>");
    assert.equal(bundleName(named), "Shown");
    assert.equal(bundleName(join(dir, "Bare Folder.app")), "Bare Folder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walks its own ancestry", { skip: globalThis.process.platform !== "darwin" }, () => {
  loadLibc(libcBeside(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "ardia-ts")));
  const chain = ancestry(globalThis.process.pid);
  assert.ok(chain.length > 0);
  assert.equal(chain[0]!.pid, globalThis.process.pid);
  assert.notEqual(chain[0]!.path, "");
  assert.equal(chain[0]!.ppid, globalThis.process.ppid);
});
