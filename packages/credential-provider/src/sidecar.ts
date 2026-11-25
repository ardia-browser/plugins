import { spawn } from "node:child_process";
import { accessSync, constants as fs } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { CREDENTIAL_LIMITS, HOST_ENV, PROGRAM_FOLDERS, VERB_TIMEOUTS_MS } from "./constants";
import { createSidecarCore, SidecarRefusal, type SidecarCore } from "./core";
import { isRecord } from "./data";
import type { CliSpec, Launch, Launcher, LaunchOutcome } from "./types";

export type NodeLauncherOptions = { env?: NodeJS.ProcessEnv; folders?: readonly string[] };

export type SidecarOptions = NodeLauncherOptions & {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  launcher?: Launcher;
};

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
  return (launch: Launch, io) =>
    new Promise<LaunchOutcome>((resolve) => {
      const program = findProgram(launch.program, { env, folders });
      if (!program) return resolve({ launched: false, status: -1, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: false });
      const child = spawn(program, [...launch.argv], { env: { ...hostEnv(env, folders), ...launch.env }, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let overflowed = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      const partial = { stdout: "", stderr: "" };
      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, VERB_TIMEOUTS_MS.killGrace).unref();
      };
      const lines = (stream: "stdout" | "stderr", text: string) => {
        partial[stream] += text;
        let end: number;
        while ((end = partial[stream].indexOf("\n")) >= 0) {
          const line = partial[stream].slice(0, end).replace(/\r$/, "");
          partial[stream] = partial[stream].slice(end + 1);
          if (line.length <= CREDENTIAL_LIMITS.streamLineBytes) io.onLine({ stream, text: line });
        }
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
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > launch.outputLimitBytes) {
          overflowed = true;
          stop();
          return;
        }
        stdout += chunk;
        lines("stdout", chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < CREDENTIAL_LIMITS.stderrBytes) stderr += chunk.slice(0, CREDENTIAL_LIMITS.stderrBytes - stderr.length);
        lines("stderr", chunk);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(launch.stdin);
      const finish = (launched: boolean, status: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ launched, status, stdout: overflowed ? "" : stdout, stderr, timedOut, overflowed, cancelled });
      };
      child.on("error", () => finish(false, -1));
      child.on("close", (code) => finish(true, code ?? -1));
    });
}

function writeLine(output: NodeJS.WritableStream, message: Record<string, unknown>) {
  output.write(`${JSON.stringify(message)}\n`);
}

export function runCredentialSidecar(spec: CliSpec, options: SidecarOptions = {}): SidecarCore {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const core = createSidecarCore(spec, options.launcher ?? nodeLauncher(options), { programFound: () => findProgram(spec.name, options) !== null });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.method !== "string" || (typeof message.id !== "number" && typeof message.id !== "string")) return;
    const id = message.id;
    core.handle(message.method, message.params).then(
      (result) => writeLine(output, { id, result: result ?? null }),
      (error: unknown) => writeLine(output, { id, error: error instanceof SidecarRefusal ? { code: error.code, message: error.message } : { code: "failed", message: error instanceof Error ? error.message : String(error) } }),
    );
  });
  lines.on("close", () => core.dispose());
  return core;
}
