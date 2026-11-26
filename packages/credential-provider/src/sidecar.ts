import { spawn } from "node:child_process";
import { accessSync, constants as fs } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { CREDENTIAL_LIMITS, HOST_ENV, PROGRAM_FOLDERS, VERB_TIMEOUTS_MS } from "./constants";
import { createSidecarCore, SidecarRefusal, type SidecarCore } from "./core";
import { splitLines } from "./lines";
import { isRecord } from "./data";
import type { ChildProcess } from "node:child_process";
import type { CliSpec, Launch, Launcher, LaunchOutcome } from "./types";

export type NodeLauncherOptions = { env?: NodeJS.ProcessEnv; folders?: readonly string[]; killGraceMs?: number; drainGraceMs?: number };

export type SidecarOptions = NodeLauncherOptions & {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  launcher?: Launcher;
  frameBytes?: number;
  replyQueue?: number;
  replyQueueBytes?: number;
};

const POSIX = process.platform !== "win32";
const live = new Set<ChildProcess>();

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (POSIX && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

export function killLiveChildren(signal: NodeJS.Signals = "SIGKILL") {
  for (const child of live) signalGroup(child, signal);
}

function searchPath(env: NodeJS.ProcessEnv, folders: readonly string[]): string[] {
  const listed = (env.PATH ?? "").split(delimiter).filter((folder) => folder.startsWith("/"));
  return [...new Set([...listed, ...folders, join(homedir(), ".local", "bin")])];
}

export function findProgram(name: string, options: NodeLauncherOptions = {}): string | null {
  if (!/^[a-z][a-z0-9._-]{0,31}$/.test(name)) return null;
  for (const folder of searchPath(options.env ?? process.env, options.folders ?? PROGRAM_FOLDERS)) {
    const candidate = join(folder, name);
    try {
      accessSync(candidate, fs.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function hostEnv(env: NodeJS.ProcessEnv, folders: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HOST_ENV) {
    const value = env[name];
    if (typeof value === "string") out[name] = value;
  }
  out.PATH = searchPath(env, folders).join(delimiter);
  return out;
}

export function nodeLauncher(options: NodeLauncherOptions = {}): Launcher {
  const env = options.env ?? process.env;
  const folders = options.folders ?? PROGRAM_FOLDERS;
  const killGrace = options.killGraceMs ?? VERB_TIMEOUTS_MS.killGrace;
  const drainGrace = options.drainGraceMs ?? VERB_TIMEOUTS_MS.drainGrace;
  return (launch: Launch, io) =>
    new Promise<LaunchOutcome>((resolve) => {
      const program = findProgram(launch.program, { env, folders });
      if (!program) return resolve({ launched: false, status: -1, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: false });
      const child = spawn(program, [...launch.argv], { env: { ...hostEnv(env, folders), ...launch.env }, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: POSIX });
      live.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflowed = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let stopping = false;
      let exited: number | null = null;
      let drain: ReturnType<typeof setTimeout> | undefined;
      const line = (stream: "stdout" | "stderr") => (bytes: Buffer) => io.onLine({ stream, text: bytes.toString("utf8") });
      const stdoutLines = splitLines(CREDENTIAL_LIMITS.streamLineBytes, line("stdout"));
      const stderrLines = splitLines(CREDENTIAL_LIMITS.streamLineBytes, line("stderr"));
      const teardown = () => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const finish = (launched: boolean, status: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (drain) clearTimeout(drain);
        if (!stopping) live.delete(child);
        stdoutLines.end();
        stderrLines.end();
        resolve({ launched, status, stdout: overflowed ? "" : Buffer.concat(stdout, stdoutBytes).toString("utf8"), stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"), timedOut, overflowed, cancelled });
      };
      const stop = () => {
        if (stopping) return;
        stopping = true;
        signalGroup(child, "SIGTERM");
        setTimeout(() => {
          signalGroup(child, "SIGKILL");
          live.delete(child);
          teardown();
          finish(true, exited ?? -1);
        }, killGrace);
        if (exited !== null) {
          teardown();
          finish(true, exited);
        }
      };
      const abandon = () => {
        const status = exited ?? -1;
        stop();
        finish(true, status);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, launch.timeoutMs);
      void io.cancelled.then(() => {
        if (settled) return;
        cancelled = true;
        stop();
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        if (overflowed) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > launch.outputLimitBytes) {
          overflowed = true;
          stdout.length = 0;
          stop();
          return;
        }
        stdout.push(chunk);
        stdoutLines.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (stderrBytes < CREDENTIAL_LIMITS.stderrBytes) {
          const piece = Buffer.from(chunk.subarray(0, CREDENTIAL_LIMITS.stderrBytes - stderrBytes));
          stderr.push(piece);
          stderrBytes += piece.length;
        }
        stderrLines.push(chunk);
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(launch.stdin);
      child.on("error", () => finish(false, -1));
      child.on("exit", (code) => {
        exited = code ?? -1;
        if (stopping) {
          teardown();
          finish(true, exited);
          return;
        }
        drain = setTimeout(abandon, drainGrace);
      });
      child.on("close", (code) => finish(true, code ?? exited ?? -1));
    });
}

type ReplyWriter = { write(message: Record<string, unknown>): void; end(): void };

function replyWriter(output: NodeJS.WritableStream, limits: { replies: number; bytes: number }, hooks: { blocked(): void; drained(): void; overflow(): void }): ReplyWriter {
  const queue: string[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let ended = false;
  const send = (line: string) => {
    if (!output.write(line)) {
      blocked = true;
      hooks.blocked();
    }
  };
  output.on("drain", () => {
    blocked = false;
    while (queue.length && !blocked) {
      const line = queue.shift()!;
      queuedBytes -= Buffer.byteLength(line);
      send(line);
    }
    if (!blocked && !queue.length) {
      hooks.drained();
      if (ended) finishOutput();
    }
  });
  const finishOutput = () => {
    if (output !== process.stdout) output.end();
  };
  return {
    write(message) {
      if (ended) return;
      const line = `${JSON.stringify(message)}\n`;
      if (!blocked) return send(line);
      const size = Buffer.byteLength(line);
      if (queue.length >= limits.replies || queuedBytes + size > limits.bytes) return hooks.overflow();
      queue.push(line);
      queuedBytes += size;
    },
    end() {
      if (ended) return;
      ended = true;
      if (!blocked) finishOutput();
    },
  };
}

const refusalOf = (error: unknown) => (error instanceof SidecarRefusal ? { code: error.code, message: error.message } : { code: "failed", message: error instanceof Error ? error.message : String(error) });

export function runCredentialSidecar(spec: CliSpec, options: SidecarOptions = {}): SidecarCore {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const core = createSidecarCore(spec, options.launcher ?? nodeLauncher(options), { programFound: () => findProgram(spec.name, options) !== null });
  let closed = false;
  const close = (reason?: { code: string; message: string }) => {
    if (closed) return;
    closed = true;
    input.removeListener("data", onData);
    input.pause();
    (input as { destroy?: () => void }).destroy?.();
    core.dispose();
    if (reason) writer.write({ id: null, error: reason });
    writer.end();
  };
  const writer = replyWriter(
    output,
    { replies: options.replyQueue ?? CREDENTIAL_LIMITS.replyQueue, bytes: options.replyQueueBytes ?? CREDENTIAL_LIMITS.replyQueueBytes },
    {
      blocked: () => input.pause(),
      drained: () => {
        if (!closed) input.resume();
      },
      overflow: () => close(),
    },
  );
  const frameBytes = options.frameBytes ?? CREDENTIAL_LIMITS.sidecarFrameBytes;
  const frames = splitLines(
    frameBytes,
    (frame) => {
      if (closed || frame.length === 0) return;
      let message: unknown;
      try {
        message = JSON.parse(frame.toString("utf8"));
      } catch {
        return;
      }
      if (!isRecord(message) || typeof message.method !== "string" || (typeof message.id !== "number" && typeof message.id !== "string")) return;
      const id = message.id;
      core.handle(message.method, message.params).then(
        (result) => writer.write({ id, result: result ?? null }),
        (error: unknown) => writer.write({ id, error: refusalOf(error) }),
      );
    },
    () => close({ code: "too_large", message: `A request was longer than ${frameBytes} bytes, so the ${spec.name} sidecar stopped.` }),
  );
  const onData = (chunk: Buffer | string) => frames.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  input.on("data", onData);
  input.on("end", () => {
    frames.end();
    close();
  });
  input.on("close", () => close());
  if (input === process.stdin) process.once("exit", () => killLiveChildren());
  return core;
}
