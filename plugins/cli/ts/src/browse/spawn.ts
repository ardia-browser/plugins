import { spawn } from "node:child_process";
import { readSync } from "node:fs";
import type { Socket } from "node:net";
import { dumps, type JsonObject } from "../json.ts";
import { flock } from "../libc.ts";
import { close, closeDir, type Dir, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY, openPrivate, openPrivateFile } from "../privatefs.ts";
import { utf8 } from "../pystr.ts";
import type { Call } from "../telemetry.ts";
import { unreachable } from "./errors.ts";
import { DIR_NAME, NoDaemon } from "./session.ts";

const START_TIMEOUT_MS = 15_000;
const POLL_MS = 30;
const LOG_TAIL = 2000;
const DAEMON = "from ardia_cli.browse import daemon; daemon.main()";

function lockHeld(dir: Dir, key: string): boolean {
  let fd: number;
  try {
    fd = openPrivateFile(`${key}.lock`, dir, O_RDONLY);
  } catch {
    return false;
  }
  try {
    return !flock(fd, false, false);
  } finally {
    close(fd);
  }
}

function logTail(dir: Dir, key: string): string {
  let fd: number;
  try {
    fd = openPrivateFile(`${key}.log`, dir, O_RDONLY);
  } catch {
    return "";
  }
  try {
    const chunks: Buffer[] = [];
    for (;;) {
      const buffer = Buffer.alloc(65536);
      const got = readSync(fd, buffer);
      if (got === 0) break;
      chunks.push(buffer.subarray(0, got));
    }
    return Buffer.concat(chunks).subarray(-LOG_TAIL).toString("utf8").trim();
  } finally {
    close(fd);
  }
}

export async function startDaemon(root: string, key: string, config: JsonObject, python: string | null, call: Call, connect: () => Promise<Socket>): Promise<Socket> {
  if (python === null) throw unreachable("the ardia browse daemon runs on the bundled Python, which isn't there");
  const dir = openPrivate(root, [DIR_NAME], true);
  try {
    const log = openPrivateFile(`${key}.log`, dir, O_WRONLY | O_CREAT | O_TRUNC);
    let child;
    try {
      child = spawn(python, ["-I", "-c", DAEMON], { stdio: ["pipe", log, log], detached: true, cwd: "/" });
    } finally {
      close(log);
    }
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    child.stdin?.end(utf8(dumps(config, "spaced")));
    child.unref();
    const spawned = performance.now();
    const started = () => {
      call.metrics.set("daemon_spawned", true);
      call.metrics.set("daemon_start_ms", BigInt(Math.round(performance.now() - spawned)));
    };
    while (performance.now() - spawned < START_TIMEOUT_MS) {
      try {
        const socket = await connect();
        started();
        return socket;
      } catch (error) {
        if (!(error instanceof NoDaemon)) throw error;
      }
      if (exited && !lockHeld(dir, key)) {
        throw unreachable(`the ardia browse daemon exited before it listened: ${logTail(dir, key) || "no output"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw unreachable("the ardia browse daemon didn't start in 15 s");
  } finally {
    closeDir(dir);
  }
}
