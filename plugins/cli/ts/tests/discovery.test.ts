import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { announcePath } from "../src/browse/daemon/announce.ts";
import { controlFilePath, fromControlFile, pidState, sandboxHint, SocketUntrusted, unreachableMessage } from "../src/browse/endpoint.ts";
import { checkSocket, missingSocketDetail, NOT_REACHABLE } from "../src/control.ts";
import { cliHome, defaultCliHome } from "../src/usage.ts";
import { agentPaths } from "../src/hooks/agent.ts";

function withEnv(values: Record<string, string | undefined>, work: () => void): void {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    work();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

function rootOwnedPid(): number | undefined {
  const listing = execFileSync("ps", ["-axo", "pid=,uid="], { encoding: "utf8" });
  for (const line of listing.split("\n")) {
    const [pid, owner] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && pid > 1 && owner === 0) return pid;
  }
  return undefined;
}

function writeControl(root: string, pid: number): string {
  const file = controlFilePath(root);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, "wx", 0o600);
  writeSync(fd, JSON.stringify({ port: 9222, browser: "/devtools/browser/abc-123", token: "t".repeat(32), pid, generation: 1 }));
  closeSync(fd);
  return file;
}

function listen(file: string): Promise<Server> {
  const server = createServer((connection) => connection.end());
  return new Promise((resolve) => server.listen(file, () => resolve(server)));
}

test("on Linux the CLI keeps its files under XDG_DATA_HOME, never ~/Library", () => {
  withEnv({ HOME: "/home/someone", XDG_DATA_HOME: undefined, ARDIA_CLI_HOME: undefined }, () => {
    assert.equal(defaultCliHome(true), "/home/someone/.local/share/ardia/cli");
    assert.equal(cliHome(true), "/home/someone/.local/share/ardia/cli");
    assert.equal(agentPaths(true).cliHome, "/home/someone/.local/share/ardia/cli");
    assert.equal(cliHome(false), "/home/someone/Library/Application Support/Ardia/CLI");
  });
  withEnv({ HOME: "/home/someone", XDG_DATA_HOME: "/data", ARDIA_CLI_HOME: undefined }, () => {
    assert.equal(cliHome(true), "/data/ardia/cli");
  });
  withEnv({ HOME: "/home/someone", XDG_DATA_HOME: "relative", ARDIA_CLI_HOME: undefined }, () => {
    assert.equal(cliHome(true), "/home/someone/.local/share/ardia/cli");
  });
  withEnv({ HOME: "/home/someone", XDG_DATA_HOME: "/data", ARDIA_CLI_HOME: "/chosen/cli" }, () => {
    assert.equal(cliHome(true), "/chosen/cli");
    assert.equal(cliHome(false), "/chosen/cli");
  });
});

test("the announce socket sits beside the control file on Linux and one folder up on the Mac", () => {
  assert.equal(announcePath("/home/someone/.config/ardia/ArdiaControl.json", true), "/home/someone/.config/ardia/ArdiaControl.sock");
  assert.equal(announcePath("/Users/someone/Library/Application Support/com.ardia.browser/Chromium/ArdiaControl.json", false), "/Users/someone/Library/Application Support/com.ardia.browser/ArdiaControl.sock");
  const root = "/scratch/profile";
  assert.equal(announcePath(controlFilePath(root)), `${root}/ArdiaControl.sock`);
});

test("EPERM from kill(pid, 0) means alive but unsignalable, ESRCH means gone", () => {
  assert.equal(pidState(42, () => true), "running");
  assert.equal(pidState(42, () => {
    throw errnoError("EPERM");
  }), "unsignalable");
  assert.equal(pidState(42, () => {
    throw errnoError("ESRCH");
  }), "gone");
  assert.equal(pidState(2 ** 30), "gone");
  assert.equal(pidState(process.pid), "running");
});

test("an unsignalable pid is trusted when its socket answers, and the hint names the path and a sandbox when it doesn't", () => {
  assert.equal(sandboxHint(7, "/data/ArdiaControl.sock", () => undefined), undefined);
  const failing = (code: number) => () => {
    const error: NodeJS.ErrnoException = new Error(String(code));
    error.errno = -code;
    throw error;
  };
  assert.match(sandboxHint(7, "/data/ArdiaControl.sock", failing(1)) ?? "", /^pid 7 can't be signalled and \/data\/ArdiaControl\.sock refused a connection \(.+\); a sandbox or the folder's permissions may be blocking it$/);
  assert.equal(sandboxHint(7, "/data/ArdiaControl.sock", failing(2)), "pid 7 can't be signalled and there's no /data/ArdiaControl.sock");
  assert.match(sandboxHint(7, "/data/ArdiaControl.sock", failing(20)) ?? "", /^pid 7 can't be signalled and \/data\/ArdiaControl\.sock couldn't be reached \(.+\)$/);
  assert.equal(
    sandboxHint(7, "/data/ArdiaControl.sock", () => {
      throw new SocketUntrusted("belongs to another user");
    }),
    "pid 7 can't be signalled and /data/ArdiaControl.sock belongs to another user",
  );
});

test("a control file whose pid answers EPERM resolves only when its own process serves the user's socket", async () => {
  const eperm = () => {
    const error: NodeJS.ErrnoException = new Error("EPERM");
    error.code = "EPERM";
    throw error;
  };
  const box = mkdtempSync(path.join(tmpdir(), "disc-"));
  try {
    const root = path.join(box, "d");
    mkdirSync(root, { mode: 0o700 });
    const file = writeControl(root, process.pid);
    assert.throws(() => fromControlFile(file, eperm), (error: Error) => error.message === `${NOT_REACHABLE} (pid ${process.pid} can't be signalled and there's no ${path.join(root, "ArdiaControl.sock")})`);
    const server = await listen(announcePath(file));
    try {
      const answered = fromControlFile(file, eperm);
      assert.equal(answered.explicit, false);
      assert.equal(unreachableMessage(answered, new Error("x")), NOT_REACHABLE);
      const stale = path.join(box, "stale");
      mkdirSync(stale, { mode: 0o700 });
      const staleFile = writeControl(stale, 4242);
      const staleServer = await listen(announcePath(staleFile));
      try {
        assert.throws(() => fromControlFile(staleFile, eperm), (error: Error) => error.message.endsWith("is served by another process than pid 4242, so the control file is stale)"));
      } finally {
        await new Promise((resolve) => staleServer.close(resolve));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("a real root-owned pid answers EPERM", { skip: process.getuid?.() === 0 || rootOwnedPid() === undefined }, () => {
  assert.equal(pidState(rootOwnedPid() as number), "unsignalable");
});

test("a missing control socket names the folder, and why Ardia would refuse to open it there", () => {
  const box = mkdtempSync(path.join(tmpdir(), "disc-"));
  try {
    const open = path.join(box, "open");
    mkdirSync(open);
    chmodSync(open, 0o775);
    assert.equal(missingSocketDetail(path.join(open, "ArdiaControl.sock")), `others can write to ${open} (mode 0775), so Ardia won't open ArdiaControl.sock there; run chmod go-w on it`);
    const closed = path.join(box, "closed");
    mkdirSync(closed, { mode: 0o700 });
    assert.equal(missingSocketDetail(path.join(closed, "ArdiaControl.sock")), `no ArdiaControl.sock in ${closed}`);
    const file = path.join(box, "file");
    writeFileSync(file, "");
    assert.equal(missingSocketDetail(path.join(file, "ArdiaControl.sock")), `${file} isn't a real folder, so Ardia won't open ArdiaControl.sock there`);
    const linked = path.join(box, "linked");
    symlinkSync(closed, linked);
    assert.equal(missingSocketDetail(path.join(linked, "ArdiaControl.sock")), `${linked} isn't a real folder, so Ardia won't open ArdiaControl.sock there`);
    assert.throws(() => checkSocket(path.join(closed, "ArdiaControl.sock")), (error: Error & { failure?: { message: string } }) => error.failure?.message === `${NOT_REACHABLE} (no ArdiaControl.sock in ${closed})`);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("a control socket the CLI may not reach says a sandbox may be blocking it", { skip: process.getuid?.() === 0 }, () => {
  const box = mkdtempSync(path.join(tmpdir(), "disc-"));
  const shut = path.join(box, "shut");
  mkdirSync(shut, { mode: 0o700 });
  chmodSync(shut, 0);
  try {
    assert.throws(() => checkSocket(path.join(shut, "ArdiaControl.sock")), (error: Error & { failure?: { message: string } }) => /ArdiaControl\.sock: Permission denied; a sandbox or the folder's permissions may be blocking it\)$/.test(error.failure?.message ?? ""));
  } finally {
    chmodSync(shut, 0o700);
    rmSync(box, { recursive: true, force: true });
  }
});
