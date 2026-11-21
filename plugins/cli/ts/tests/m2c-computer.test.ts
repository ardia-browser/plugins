import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { CommandIo } from "../src/cmdio.ts";
import { APP_BINARY, APP_NAME, bundledApp, BUNDLE_ID, cuaHome, extract, keepsDriverFile, Refused, tools, VERSION, versionHome } from "../src/computer/driver.ts";
import { readRecord, saveRecord } from "../src/computer/apps.ts";
import { computerMain, mcpConfig } from "../src/computer/cli.ts";
import { loadPlist } from "../src/plist.ts";

const macOnly = process.platform === "darwin" ? test : test.skip;
const scratch = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "m2c-computer-")));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function infoPlist(id: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${id}</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
</dict>
</plist>
`;
}

function makeApp(where: string, version = VERSION, id = BUNDLE_ID): void {
  fs.mkdirSync(path.join(where, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(where, "Contents", "Info.plist"), infoPlist(id, version));
  fs.writeFileSync(path.join(where, APP_BINARY), `#!/bin/sh\necho "${version} $*" >> "$(dirname "$0")/../../../driver.log"\n`, { mode: 0o755 });
}

type Sandbox = { root: string; applications: string; cliHome: string; out: string[]; err: string[]; io: CommandIo };

function sandbox(): Sandbox {
  counter += 1;
  const root = path.join(scratch, `s${counter}`);
  const applications = path.join(root, "Applications");
  const cliHome = path.join(root, "cli");
  const bin = path.join(root, "tools");
  fs.mkdirSync(applications, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "codesign"),
    `#!/bin/sh
last=""; for word in "$@"; do last="$word"; done
case "$1" in
  --verify) if [ -e "$last/Contents/TAMPERED" ]; then echo "$last: a sealed resource is missing or invalid" >&2; exit 1; fi; exit 0 ;;
  -dvvv) printf 'Executable=%s\\nCDHash=%s\\n' "$last" "$(cat "$last/Contents/Info.plist" | shasum | cut -c1-40)" >&2; exit 0 ;;
esac
exit 2
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "ditto"), `#!/bin/sh\nexec /bin/cp -R "$1" "$2"\n`, { mode: 0o755 });
  tools.codesign = path.join(bin, "codesign");
  tools.ditto = path.join(bin, "ditto");
  tools.lsregister = "/usr/bin/true";
  tools.applications = applications;
  tools.releaseUrl = "http://127.0.0.1:9/nothing";
  process.env.ARDIA_CLI_HOME = cliHome;
  process.env.ARDIA_CLI_BIN_DIR = path.join(root, "bin");
  const out: string[] = [];
  const err: string[] = [];
  const io = new CommandIo(false, (stream, text) => (stream === 1 ? out : err).push(text));
  return { root, applications, cliHome, out, err, io };
}

function hashOf(app: string): string {
  return execFileSync("/bin/sh", ["-c", `cat "${app}/Contents/Info.plist" | shasum | cut -c1-40`]).toString().trim();
}

async function run(box: Sandbox, argv: string[]): Promise<number> {
  const status = await computerMain(box.io, argv);
  box.io.flush();
  return status;
}

macOnly("refresh does nothing when CuaDriver.app is missing, current, or not ardia's", async () => {
  const box = sandbox();
  assert.equal(await run(box, ["refresh"]), 0);
  assert.ok(fs.existsSync(path.join(cuaHome(), ".applications.lock")));
  makeApp(path.join(box.applications, APP_NAME), "0.30.0");
  assert.equal(await run(box, ["refresh"]), 0);
  assert.deepEqual([box.out, box.err], [[], []]);
});

macOnly("refresh updates an old CuaDriver.app ardia put there, from the cached driver", async () => {
  const box = sandbox();
  const dest = path.join(box.applications, APP_NAME);
  makeApp(dest, "0.30.0");
  saveRecord(new Map([["path", dest], ["version", "0.30.0"], ["cdhash", hashOf(dest)], ["state", "committed"]]));
  makeApp(bundledApp());
  assert.equal(await run(box, ["refresh"]), 0);
  assert.deepEqual(box.out, [`updated ${dest} (${VERSION})\n`]);
  const record = readRecord();
  assert.equal(record.get("state"), "committed");
  assert.equal(record.get("version"), VERSION);
  assert.equal(record.get("cdhash"), hashOf(dest));
  assert.equal(fs.readFileSync(path.join(box.applications, "driver.log"), "utf8"), "0.30.0 stop\n");
  assert.deepEqual(fs.readdirSync(box.applications).sort(), [APP_NAME, "driver.log"]);
  assert.match(fs.readFileSync(path.join(cuaHome(), "applications.json"), "utf8"), /^\{\n  "path": /);
});

macOnly("setup installs, links a cua-driver command, turns telemetry off and stops before the grant", async () => {
  const box = sandbox();
  fs.mkdirSync(path.join(box.cliHome, "current", "bin"), { recursive: true });
  fs.writeFileSync(path.join(box.cliHome, "current", "bin", "ardia"), "#!/bin/sh\n");
  makeApp(bundledApp());
  assert.equal(await run(box, ["setup", "--no-grant"]), 0);
  const dest = path.join(box.applications, APP_NAME);
  const shim = path.join(cuaHome(), "bin", "cua-driver");
  const link = path.join(box.root, "bin", "cua-driver");
  assert.deepEqual(box.out, [
    `installed ${dest} (${VERSION})\nlinked ${link} -> ${shim}\ncua-driver telemetry off (cua-driver telemetry enable turns it back on)\nnext: ardia computer permissions grant\n`,
  ]);
  assert.equal(fs.readFileSync(shim, "utf8"), `#!/bin/sh\nexec ${path.join(box.cliHome, "current", "bin", "ardia")} computer "$@"\n`);
  assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
  assert.equal(fs.readlinkSync(link), shim);
  box.out.length = 0;
  assert.equal(await run(box, ["setup", "--no-grant"]), 0);
  assert.deepEqual(box.out, [`current ${dest} (${VERSION})\ncurrent ${link}\ncua-driver telemetry off (cua-driver telemetry enable turns it back on)\nnext: ardia computer permissions grant\n`]);
});

macOnly("setup keeps a CuaDriver.app someone else installed and a cua-driver link that isn't ardia's", async () => {
  const box = sandbox();
  fs.mkdirSync(path.join(box.cliHome, "current", "bin"), { recursive: true });
  fs.writeFileSync(path.join(box.cliHome, "current", "bin", "ardia"), "#!/bin/sh\n");
  fs.mkdirSync(path.join(box.root, "bin"));
  fs.writeFileSync(path.join(box.root, "bin", "cua-driver"), "mine");
  makeApp(path.join(box.applications, APP_NAME), "0.37.0");
  makeApp(bundledApp());
  assert.equal(await run(box, ["setup", "--no-grant"]), 0);
  assert.equal(box.out[0]?.split("\n")[0], `kept ${path.join(box.applications, APP_NAME)}: CuaDriver.app 0.37.0 was put there by something other than ardia (cua's own installer?); ardia computer uses it as is`);
  assert.equal(box.out[0]?.split("\n")[1], `kept ${path.join(box.root, "bin", "cua-driver")}: it isn't ardia's; run ardia computer instead of cua-driver`);
});

macOnly("a pending install is finished or rolled back on the next run", async () => {
  const box = sandbox();
  const dest = path.join(box.applications, APP_NAME);
  makeApp(dest);
  fs.mkdirSync(path.join(box.applications, `.${APP_NAME}.ardia-new`));
  saveRecord(new Map([["path", dest], ["version", VERSION], ["cdhash", hashOf(dest)], ["state", "pending"], ["previous", null]]));
  assert.equal(await run(box, ["refresh"]), 0);
  assert.equal(readRecord().get("state"), "committed");
  assert.ok(!fs.existsSync(path.join(box.applications, `.${APP_NAME}.ardia-new`)));
  saveRecord(new Map([["path", dest], ["version", VERSION], ["cdhash", "0000"], ["state", "pending"], ["previous", null]]));
  assert.equal(await run(box, ["refresh"]), 0);
  assert.ok(!fs.existsSync(path.join(cuaHome(), "applications.json")));
});

macOnly("the driver runs only once verified, and a tampered one is refused", async () => {
  const box = sandbox();
  const dest = path.join(box.applications, APP_NAME);
  makeApp(dest);
  assert.equal(await run(box, ["list-tools"]), 0);
  assert.deepEqual(box.io.exec, { binary: path.join(dest, APP_BINARY), argv: [path.join(dest, APP_BINARY), "list-tools"] });
  box.io.exec = undefined;
  assert.equal(await run(box, ["help", "x"]), 0);
  assert.deepEqual((box.io.exec as { argv: string[] } | undefined)?.argv.slice(1), ["--help", "x"]);
  box.io.exec = undefined;
  fs.writeFileSync(path.join(dest, "Contents", "TAMPERED"), "");
  assert.equal(await run(box, ["list-tools"]), 1);
  assert.deepEqual(box.err, [`ardia computer: ${dest} isn't Cua AI's signed ${APP_NAME} (${dest}: a sealed resource is missing or invalid). ardia won't run it: move it away and run ardia computer setup\n`]);
  assert.equal(box.io.exec, undefined);
});

macOnly("daemon commands need setup, others download the pinned driver over https only", async () => {
  const box = sandbox();
  assert.equal(await run(box, ["mcp"]), 1);
  assert.match(box.err[0] ?? "", /^ardia computer: Cua Driver isn't set up yet\. Run ardia computer setup: it puts CuaDriver\.app in /);
  box.err.length = 0;
  assert.equal(await run(box, ["doctor"]), 1);
  assert.deepEqual(box.err, [`step download http://127.0.0.1:9/nothing/cua-driver-rs-${VERSION}-darwin-arm64.tar.gz\n`, `ardia computer: refused a download that isn't https: http://127.0.0.1:9/nothing/cua-driver-rs-${VERSION}-darwin-arm64.tar.gz\n`]);
  assert.ok(!fs.readdirSync(versionHome()).some((name) => name.startsWith(".driver-")));
});

test("mcp-config refuses without a trusted launcher and names it when there is one", () => {
  sandbox();
  assert.throws(() => mcpConfig("general"), (error: unknown) => error instanceof Refused && error.message.startsWith("can't find the installed ardia launcher"));
  const box = sandbox();
  const launcher = path.join(box.cliHome, "current", "bin", "ardia");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "");
  assert.equal(mcpConfig("codex"), `codex mcp add cua-driver -- ${launcher} computer mcp`);
  assert.equal(mcpConfig("claude-code"), `claude mcp add-json --scope user cua-driver '{"command": "${launcher}", "args": ["computer", "mcp"]}'`);
});

test("only the driver's files come out of its archive, and links or escapes are refused", () => {
  const box = sandbox();
  const top = `cua-driver-rs-${VERSION}-darwin-arm64`;
  const tree = path.join(box.root, "tree");
  makeApp(path.join(tree, top, APP_NAME));
  fs.writeFileSync(path.join(tree, top, "LICENSE"), "MIT");
  fs.writeFileSync(path.join(tree, top, "README.md"), "skip");
  fs.chmodSync(path.join(tree, top, "LICENSE"), 0o4777);
  const archive = path.join(box.root, "a.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", tree, top], { env: { COPYFILE_DISABLE: "1" } });
  const dest = path.join(box.root, "out");
  fs.mkdirSync(dest);
  const taken = extract(archive, top, dest, keepsDriverFile).sort();
  assert.deepEqual(taken, ["CuaDriver.app/Contents/Info.plist", `CuaDriver.app/${APP_BINARY}`, "LICENSE"].sort());
  assert.ok(!fs.existsSync(path.join(dest, "README.md")));
  assert.equal(fs.statSync(path.join(dest, "LICENSE")).mode & 0o7777, 0o755);
  fs.symlinkSync("/etc/passwd", path.join(tree, top, "CuaDriver.app", "evil"));
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", tree, top], { env: { COPYFILE_DISABLE: "1" } });
  assert.throws(() => extract(archive, top, path.join(box.root, "out2"), keepsDriverFile), (error: unknown) => error instanceof Refused && error.message.includes("has a link or special file"));
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", tree, "."], { env: { COPYFILE_DISABLE: "1" } });
  assert.throws(() => extract(archive, top, path.join(box.root, "out3"), keepsDriverFile), (error: unknown) => error instanceof Refused && error.message.includes("has an entry outside"));
});

macOnly("Info.plist reads in XML and binary form", () => {
  const box = sandbox();
  const file = path.join(box.root, "Info.plist");
  fs.writeFileSync(file, infoPlist("com.trycua.driver", "0.38.0"));
  const xml = loadPlist(fs.readFileSync(file));
  execFileSync("/usr/bin/plutil", ["-convert", "binary1", file]);
  const binary = loadPlist(fs.readFileSync(file));
  for (const parsed of [xml, binary]) {
    assert.ok(parsed instanceof Map);
    assert.equal(parsed.get("CFBundleIdentifier"), "com.trycua.driver");
    assert.equal(parsed.get("CFBundleShortVersionString"), "0.38.0");
  }
});

test("off macOS computer refresh does nothing and setup says it needs macOS", { skip: process.platform === "darwin" }, async () => {
  const box = sandbox();
  assert.equal(await run(box, ["refresh"]), 0);
  assert.ok(!fs.existsSync(cuaHome()));
  assert.equal(await run(box, ["setup"]), 1);
  assert.deepEqual(box.err, ["ardia computer: computer use through cua-driver needs macOS here\n"]);
});
