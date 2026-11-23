import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, test } from "bun:test";
import "./libc-loaded.ts";
import { CommandIo } from "../src/cmdio.ts";
import { APP_BINARY, APP_NAME, BUNDLE_ID, tools, VERSION } from "../src/computer/driver.ts";
import { computerMain } from "../src/computer/cli.ts";
import { classifyDriverExit, COMPUTER_ERROR_CODES, driverExitCode, EXACT_EXITS, grantsOf, missingGrantsIn, permissionCode } from "../src/computer/codes.ts";
import { daemonTiming, explicitSocket } from "../src/computer/daemon.ts";
import { driverOutput } from "../src/computer/supervise.ts";
import { cleanEvent, TELEMETRY_ERROR_CODES } from "../src/telemetry-schema.ts";
import { object, type Value } from "../src/json.ts";

const macOnly = process.platform === "darwin" ? test : test.skip;
const scratch = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "cerr-")));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const STUB_ENV = ["STUB_EXIT", "STUB_STDERR", "STUB_STDOUT", "STUB_SIGNAL", "STUB_GRANTS", "STUB_GRANTS_EXIT"];
const servers: net.Server[] = [];
const timers: ReturnType<typeof setInterval>[] = [];

afterEach(() => {
  for (const name of STUB_ENV) delete process.env[name];
  for (const server of servers.splice(0)) server.close();
  for (const timer of timers.splice(0)) clearInterval(timer);
  daemonTiming.startTimeoutMs = 15_000;
});

const DRIVER = `#!/bin/sh
here=$(cd "$(dirname "$0")/../../.." && pwd)
echo "$*" >> "$here/driver.log"
if [ "$1 $2 $3" = "permissions status --json" ]; then
  if [ -n "\${STUB_GRANTS:-}" ]; then printf '%s\\n' "$STUB_GRANTS"; else printf '%s\\n' '{"accessibility":true,"screen_recording":true}'; fi
  exit \${STUB_GRANTS_EXIT:-0}
fi
[ -n "\${STUB_STDOUT:-}" ] && printf '%s\\n' "$STUB_STDOUT"
[ -n "\${STUB_STDERR:-}" ] && printf '%s\\n' "$STUB_STDERR" >&2
[ -n "\${STUB_SIGNAL:-}" ] && kill -"$STUB_SIGNAL" $$
exit \${STUB_EXIT:-0}
`;

function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${BUNDLE_ID}</string>
	<key>CFBundleShortVersionString</key>
	<string>${VERSION}</string>
</dict>
</plist>
`;
}

type Box = { root: string; app: string; socket: string; out: string[]; err: string[]; driver: string[]; io: CommandIo; log: () => string[] };

function box(options: { installed?: boolean; open?: "fails" | "opens" } = {}): Box {
  counter += 1;
  const root = path.join(scratch, `b${counter}`);
  const applications = path.join(root, "Applications");
  const bin = path.join(root, "tools");
  fs.mkdirSync(applications, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const app = path.join(applications, APP_NAME);
  if (options.installed !== false) {
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), infoPlist());
    fs.writeFileSync(path.join(app, APP_BINARY), DRIVER, { mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(bin, "codesign"),
    `#!/bin/sh\nlast=""; for word in "$@"; do last="$word"; done\nif [ -e "$last/Contents/TAMPERED" ]; then echo "$last: a sealed resource is missing or invalid" >&2; exit 1; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  const opened = path.join(root, "opened");
  fs.writeFileSync(
    path.join(bin, "open"),
    options.open === "fails"
      ? `#!/bin/sh\necho "The application cannot be opened for an unexpected reason, error=Error Domain=NSOSStatusErrorDomain Code=-10827" >&2\nexit 1\n`
      : `#!/bin/sh\necho "$*" > "${opened}"\nexit 0\n`,
    { mode: 0o755 },
  );
  tools.codesign = path.join(bin, "codesign");
  tools.open = path.join(bin, "open");
  tools.lsregister = "/usr/bin/true";
  tools.applications = applications;
  tools.releaseUrl = "http://127.0.0.1:9/nothing";
  const socket = path.join(root, "d.sock");
  tools.socket = socket;
  process.env.ARDIA_CLI_HOME = path.join(root, "cli");
  process.env.ARDIA_CLI_BIN_DIR = path.join(root, "bin");
  const out: string[] = [];
  const err: string[] = [];
  const io = new CommandIo(false, (stream, text) => (stream === 1 ? out : err).push(text));
  const log = () => {
    const file = path.join(applications, "driver.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd().split("\n") : [];
  };
  return { root, app, socket, out, err, driver: [], io, log };
}

async function listen(socket: string): Promise<void> {
  const server = net.createServer((connection) => connection.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
}

function listenOnceOpened(b: Box): void {
  const marker = path.join(b.root, "opened");
  const timer = setInterval(() => {
    if (!fs.existsSync(marker)) return;
    clearInterval(timer);
    void listen(b.socket);
  }, 20);
  timers.push(timer);
}

async function run(b: Box, argv: string[]): Promise<number> {
  const write = driverOutput.write;
  driverOutput.write = (fd, bytes) => void b.driver.push(`${fd}:${Buffer.from(bytes).toString("utf8")}`);
  try {
    const status = await computerMain(b.io, argv);
    b.io.flush();
    return status;
  } finally {
    driverOutput.write = write;
  }
}

function errText(b: Box): string {
  return b.err.join("");
}

test("every computer error code is allowlisted, and telemetry keeps it verbatim", () => {
  for (const code of COMPUTER_ERROR_CODES) {
    assert.ok(TELEMETRY_ERROR_CODES.has(code), code);
    assert.match(code, /^[a-z][a-z0-9_]{0,40}$/);
    const record = object([
      ["uuid", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"],
      ["event", "cli_command"],
      ["timestamp", "2026-11-23T10:00:00Z"],
      ["properties", object([["command", "computer"], ["subcommand", "call"], ["exit_code", 1n], ["error_code", code]])],
    ]);
    const kept = cleanEvent(record)?.get("properties") as Map<string, Value>;
    assert.equal(kept.get("error_code"), code);
  }
  const unknown = object([
    ["uuid", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"],
    ["event", "cli_command"],
    ["timestamp", "2026-11-23T10:00:00Z"],
    ["properties", object([["error_code", "driver_exit_999"]])],
  ]);
  assert.equal((cleanEvent(unknown)?.get("properties") as Map<string, Value>).get("error_code"), "other");
});

test("driver exits bucket to a fixed set", () => {
  for (const status of EXACT_EXITS) assert.ok(COMPUTER_ERROR_CODES.includes(driverExitCode(status)));
  assert.equal(driverExitCode(3), "driver_exit_3");
  assert.equal(driverExitCode(70), "driver_exit_70");
  assert.equal(driverExitCode(16), "driver_exit_other");
  assert.equal(driverExitCode(200), "driver_exit_other");
  assert.equal(driverExitCode(137), "driver_signal");
  for (let status = 1; status < 256; status += 1) assert.ok(COMPUTER_ERROR_CODES.includes(driverExitCode(status)), String(status));
});

test("the driver's real exit codes and messages map to codes", () => {
  const cases: [string, number, string, string][] = [
    ["call", 1, "Cua Driver daemon is not running on /x/cua-driver.sock.\nStart it first with: cua-driver serve --socket /x/cua-driver.sock\n", "daemon_not_running"],
    ["status", 1, "Cua Driver daemon is not running\n", "daemon_not_running"],
    ["call", 2, "error: positional JSON arg to 'cua-driver call' did not parse: EOF while parsing an object at line 1 column 1\n", "bad_arguments"],
    ["call", 64, "Unknown tool: nonexistent_tool\n", "bad_arguments"],
    ["describe", 64, "Unknown tool: x\nAvailable tools:\n  click\n", "bad_arguments"],
    ["call", 1, "Missing required integer field: pid\n", "tool_failed"],
    ["call", 1, "Accessibility permission not granted\n", "permission_accessibility_missing"],
    ["call", 1, "Screen Recording permission not granted\n", "permission_screen_recording_missing"],
    ["call", 1, "Accessibility is NOT granted for this process\nScreen Recording is NOT granted for this process\n", "permission_both_missing"],
    ["doctor", 1, "[err ] permission rows: stale\n", "doctor_probe_failed"],
    ["diagnose", 3, "", "doctor_probe_failed"],
    ["list-tools", 5, "", "driver_exit_5"],
    ["stop", 99, "", "driver_exit_other"],
    ["call", 143, "", "driver_signal"],
  ];
  for (const [command, status, text, code] of cases) assert.equal(classifyDriverExit(command, status, text), code, `${command} ${status} ${text}`);
});

test("grants come from the driver's permissions status payload", () => {
  assert.deepEqual(grantsOf({ daemon_running: false, status: "unknown", reason: "…" }), { running: false });
  assert.deepEqual(grantsOf({ accessibility: true, screen_recording: false, source: {} }), { running: true, grants: { accessibility: true, screenRecording: false } });
  assert.equal(grantsOf({ accessibility: "yes" }), undefined);
  assert.equal(grantsOf([]), undefined);
  assert.equal(grantsOf(null), undefined);
  assert.equal(permissionCode({ accessibility: true, screenRecording: true }), undefined);
  assert.equal(permissionCode({ accessibility: false, screenRecording: true }), "permission_accessibility_missing");
  assert.equal(permissionCode({ accessibility: true, screenRecording: false }), "permission_screen_recording_missing");
  assert.equal(permissionCode({ accessibility: false, screenRecording: false }), "permission_both_missing");
  assert.equal(missingGrantsIn("Accessibility:    ✅ granted\nScreen Recording: ✅ granted\n"), undefined);
  assert.equal(explicitSocket(["call", "x", "--socket", "/s"]), true);
  assert.equal(explicitSocket(["call", "x", "--socket=/s"]), true);
  assert.equal(explicitSocket(["call", "x", "--", "--socket"]), false);
});

macOnly("a daemon command before setup names setup and the permissions, with driver_not_installed", async () => {
  for (const command of ["call", "permissions", "mcp", "serve"]) {
    const b = box({ installed: false });
    assert.equal(await run(b, [command, "list_apps"]), 1);
    assert.equal(b.io.errorCode, "driver_not_installed");
    assert.equal(
      errText(b),
      `ardia computer: Cua Driver isn't set up yet. Run ardia computer setup: it puts CuaDriver.app in ${tools.applications}, which macOS ties the Accessibility and Screen Recording permissions to, and asks for them. \`ardia computer ${command}\` needs it\n`,
    );
    assert.deepEqual(b.log(), []);
  }
});

macOnly("a tampered CuaDriver.app is driver_unverified and never runs", async () => {
  const b = box();
  fs.writeFileSync(path.join(b.app, "Contents", "TAMPERED"), "");
  assert.equal(await run(b, ["call", "list_apps"]), 1);
  assert.equal(b.io.errorCode, "driver_unverified");
  assert.match(errText(b), /isn't Cua AI's signed CuaDriver\.app .* move it away and run ardia computer setup\n$/);
  assert.deepEqual(b.log(), []);
});

macOnly("the first call starts the daemon through macOS, then runs", async () => {
  const b = box();
  listenOnceOpened(b);
  assert.equal(await run(b, ["call", "list_apps"]), 0);
  assert.equal(fs.readFileSync(path.join(b.root, "opened"), "utf8"), `-g -a ${b.app} --args serve\n`);
  assert.deepEqual(b.log(), ["permissions status --json", "call list_apps"]);
  assert.equal(b.io.errorCode, undefined);
  assert.equal(errText(b), "");
});

macOnly("a running daemon is used as is, with no extra driver runs", async () => {
  const b = box();
  await listen(b.socket);
  assert.equal(await run(b, ["call", "list_apps"]), 0);
  assert.ok(!fs.existsSync(path.join(b.root, "opened")));
  assert.deepEqual(b.log(), ["call list_apps"]);
});

macOnly("macOS refusing to open CuaDriver.app is daemon_start_failed", async () => {
  const b = box({ open: "fails" });
  assert.equal(await run(b, ["call", "list_apps"]), 1);
  assert.equal(b.io.errorCode, "daemon_start_failed");
  assert.equal(
    errText(b),
    [
      `ardia computer: macOS couldn't open ${b.app}: The application cannot be opened for an unexpected reason, error=Error Domain=NSOSStatusErrorDomain Code=-10827.`,
      "  fix: ardia computer permissions grant   (starts Cua Driver through macOS and checks its permissions)",
      "   or: ardia computer doctor              (says what's wrong with the install)",
      "",
    ].join("\n"),
  );
  assert.deepEqual(b.log(), []);
});

macOnly("a daemon that never listens is daemon_timeout and mentions the permission prompts", async () => {
  const b = box();
  daemonTiming.startTimeoutMs = 300;
  assert.equal(await run(b, ["call", "list_apps"]), 1);
  assert.equal(b.io.errorCode, "daemon_timeout");
  assert.equal(
    errText(b),
    [
      "ardia computer: Cua Driver's background service didn't start within 1 s.",
      "  If macOS is showing CuaDriver's permission prompts, allow Accessibility and Screen Recording for CuaDriver.app and run the command again.",
      "  fix: ardia computer permissions grant   (starts Cua Driver through macOS and checks its permissions)",
      "   or: ardia computer doctor              (says what's wrong with the install)",
      "",
    ].join("\n"),
  );
});

const GRANT_CASES: [string, string, string[]][] = [
  ['{"accessibility":false,"screen_recording":true}', "permission_accessibility_missing", ["Accessibility"]],
  ['{"accessibility":true,"screen_recording":false}', "permission_screen_recording_missing", ["Screen & System Audio Recording"]],
  ['{"accessibility":false,"screen_recording":false}', "permission_both_missing", ["Accessibility", "Screen & System Audio Recording"]],
];

macOnly("missing permissions after starting the daemon stop the call with the exact permission, app and fix", async () => {
  for (const [grants, code, panes] of GRANT_CASES) {
    const b = box();
    listenOnceOpened(b);
    process.env.STUB_GRANTS = grants;
    assert.equal(await run(b, ["call", "click", '{"pid":844,"x":1,"y":2}']), 1);
    assert.equal(b.io.errorCode, code);
    const text = errText(b);
    const what = panes.length === 2 ? "the Accessibility and Screen Recording permissions" : panes[0] === "Accessibility" ? "the Accessibility permission" : "the Screen Recording permission";
    assert.ok(text.startsWith(`ardia computer: ${b.app} doesn't have ${what} yet. macOS ties ${panes.length === 2 ? "them" : "it"} to CuaDriver.app (com.trycua.driver), not to your terminal or agent`), text);
    assert.ok(text.includes("  fix: ardia computer permissions grant"), text);
    for (const pane of panes) assert.ok(text.includes(`System Settings > Privacy & Security > ${pane}`), text);
    assert.equal(text.includes("Privacy_Accessibility"), panes.includes("Accessibility"));
    assert.equal(text.includes("Privacy_ScreenCapture"), panes.includes("Screen & System Audio Recording"));
    assert.ok(!text.includes("844"));
    assert.deepEqual(b.log(), ["permissions status --json"]);
  }
});

macOnly("a failed call with a running daemon is classified after the fact", async () => {
  const b = box();
  await listen(b.socket);
  process.env.STUB_EXIT = "1";
  process.env.STUB_STDOUT = "Missing required integer field: pid";
  assert.equal(await run(b, ["call", "get_window_state", '{"pid":"Secret Notes"}']), 1);
  assert.equal(b.io.errorCode, "tool_failed");
  assert.deepEqual(b.driver, ["1:Missing required integer field: pid\n"]);
  assert.equal(errText(b), "");
  assert.deepEqual(b.log(), ['call get_window_state {"pid":"Secret Notes"}', "permissions status --json"]);

  const revoked = box();
  await listen(revoked.socket);
  process.env.STUB_GRANTS = '{"accessibility":true,"screen_recording":false}';
  assert.equal(await run(revoked, ["call", "screenshot"]), 1);
  assert.equal(revoked.io.errorCode, "permission_screen_recording_missing");
  assert.match(errText(revoked), /doesn't have the Screen Recording permission yet/);
});

macOnly("bad arguments, unknown tools and signals skip the follow-up check", async () => {
  const cases: [Record<string, string>, number, string][] = [
    [{ STUB_EXIT: "64", STUB_STDERR: "Unknown tool: nonexistent_tool" }, 64, "bad_arguments"],
    [{ STUB_EXIT: "2", STUB_STDERR: "error: positional JSON arg to 'cua-driver call' did not parse" }, 2, "bad_arguments"],
    [{ STUB_SIGNAL: "TERM" }, 143, "driver_signal"],
  ];
  for (const [env, status, code] of cases) {
    const b = box();
    await listen(b.socket);
    Object.assign(process.env, env);
    assert.equal(await run(b, ["call", "x", "{}"]), status);
    assert.equal(b.io.errorCode, code);
    assert.equal(b.log().length, 1);
    for (const name of STUB_ENV) delete process.env[name];
  }
});

macOnly("an explicit --socket is never auto-started, and a down daemon there says how to start it", async () => {
  const b = box();
  process.env.STUB_EXIT = "1";
  process.env.STUB_STDERR = "Cua Driver daemon is not running on /tmp/other.sock.\nStart it first with: cua-driver serve --socket /tmp/other.sock";
  assert.equal(await run(b, ["call", "list_apps", "--socket", "/tmp/other.sock"]), 1);
  assert.equal(b.io.errorCode, "daemon_not_running");
  assert.ok(!fs.existsSync(path.join(b.root, "opened")));
  assert.ok(errText(b).startsWith("ardia computer: Cua Driver's background service isn't running on that socket"));
  assert.deepEqual(b.log(), ["call list_apps --socket /tmp/other.sock"]);
});

macOnly("a grant that fails with the service down says it isn't running, with daemon_not_running", async () => {
  const b = box();
  process.env.STUB_EXIT = "1";
  process.env.STUB_GRANTS = '{"daemon_running":false,"status":"unknown"}';
  assert.equal(await run(b, ["permissions", "grant"]), 1);
  assert.equal(b.io.errorCode, "daemon_not_running");
  assert.equal(
    errText(b),
    [
      "ardia computer: Cua Driver's background service isn't running.",
      "  fix: ardia computer permissions grant   (starts it through macOS so the permissions stay CuaDriver.app's)",
      "   or: ardia computer doctor              (says what's wrong with the install)",
      "",
    ].join("\n"),
  );
});

macOnly("permissions, doctor, status and other commands keep the driver's exit and get a code", async () => {
  const cases: [string[], Record<string, string>, number, string | undefined][] = [
    [["permissions", "grant"], { STUB_EXIT: "1", STUB_GRANTS: '{"accessibility":false,"screen_recording":false}' }, 1, "permission_both_missing"],
    [["permissions", "grant"], { STUB_EXIT: "3" }, 3, "driver_exit_3"],
    [["doctor"], { STUB_EXIT: "1" }, 1, "doctor_probe_failed"],
    [["status"], { STUB_EXIT: "1", STUB_STDERR: "Cua Driver daemon is not running" }, 1, "daemon_not_running"],
    [["list-tools"], { STUB_EXIT: "200" }, 200, "driver_exit_other"],
    [["describe", "nope"], { STUB_EXIT: "64", STUB_STDERR: "Unknown tool: nope" }, 64, "bad_arguments"],
    [["doctor"], {}, 0, undefined],
  ];
  for (const [argv, env, status, code] of cases) {
    const b = box();
    await listen(b.socket);
    Object.assign(process.env, env);
    assert.equal(await run(b, argv), status, argv.join(" "));
    assert.equal(b.io.errorCode, code, argv.join(" "));
    for (const name of STUB_ENV) delete process.env[name];
  }
});

macOnly("permissions status keeps exit 0 and adds the fix when a grant is missing", async () => {
  const b = box();
  await listen(b.socket);
  process.env.STUB_STDOUT = "Accessibility:    ❌ not granted\nScreen Recording: ✅ granted";
  process.env.STUB_GRANTS = '{"accessibility":false,"screen_recording":true}';
  assert.equal(await run(b, ["permissions"]), 0);
  assert.equal(b.io.errorCode, undefined);
  assert.match(errText(b), /doesn't have the Accessibility permission yet/);
  assert.deepEqual(b.driver, ["1:Accessibility:    ❌ not granted\nScreen Recording: ✅ granted\n"]);
});

macOnly("a driver that can't be spawned is driver_spawn_failed", async () => {
  const b = box();
  await listen(b.socket);
  fs.chmodSync(path.join(b.app, APP_BINARY), 0o644);
  assert.equal(await run(b, ["list-tools"]), 1);
  assert.equal(b.io.errorCode, "driver_spawn_failed");
  assert.match(errText(b), /^PermissionError: \[Errno 13\] Permission denied: '.*cua-driver'\n$/);
});

macOnly("ardia's own refusals carry codes too", async () => {
  const b = box();
  assert.equal(await run(b, ["update"]), 2);
  assert.equal(b.io.errorCode, "driver_command_refused");
  const usage = box();
  assert.equal(await run(usage, ["setup", "--nope"]), 2);
  assert.equal(usage.io.errorCode, "usage_error");
  const launcher = box();
  assert.equal(await run(launcher, ["mcp-config"]), 1);
  assert.equal(launcher.io.errorCode, "launcher_missing");
});
