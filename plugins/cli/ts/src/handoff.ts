import { closeSync, existsSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export function installRoot(): string | null {
  try {
    return dirname(dirname(realpathSync(process.execPath)));
  } catch {
    return null;
  }
}

export function bundledPython(root: string | null = installRoot()): string | null {
  return root === null ? null : join(root, "python", "bin", "python3");
}

export function takeLease(root: string | null): string | undefined {
  if (root === null) return undefined;
  const leases = join(root, ".leases");
  try {
    if (!statSync(leases).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const path = join(leases, String(process.pid));
  try {
    closeSync(openSync(path, "w"));
    return path;
  } catch {
    return undefined;
  }
}

export function dropLease(path: string | undefined): void {
  if (path === undefined) return;
  try {
    unlinkSync(path);
  } catch {}
}

function complain(text: string): void {
  try {
    writeSync(2, text);
  } catch {}
}

function decodedLossily(argv: string[]): boolean {
  const lossy = (text: string | undefined) => text?.includes("\ufffd") ?? false;
  return argv.some(lossy) || Object.entries(process.env).some(([key, value]) => lossy(key) || lossy(value));
}

async function cannotRun(python: string, errno: number): Promise<number> {
  const { DARWIN_ERRORS } = await import("./errnos.ts");
  complain(`ardia: couldn't run ${python}: ${DARWIN_ERRORS[errno] ?? `Unknown error: ${errno}`}\n`);
  return 127;
}

const BOURNE_SHELL = "/bin/sh";

export async function handOff(argv: string[], python: string | null = bundledPython(), lease?: string): Promise<number> {
  if (python === null || !existsSync(python)) {
    complain(`ardia: this command runs on the bundled Python, which isn't there (${python ?? "next to this ardia"})\n`);
    return 127;
  }
  const { E2BIG, ENOEXEC, errnoOf, exceedsArgMax, execBlocker } = await import("./exec-check.ts");
  const blocked = execBlocker(python);
  if (blocked !== undefined && blocked !== ENOEXEC) return cannotRun(python, blocked);
  try {
    if (blocked === undefined && decodedLossily(argv)) {
      const raw = await import("./raw-handoff.ts");
      const folder = await raw.parcelRawWords();
      if (folder !== undefined) raw.execTrampoline(python, folder, lease);
    }
    const words = [python, "-I", "-m", "ardia_cli", ...argv];
    const [program, programWords] = blocked === ENOEXEC ? [BOURNE_SHELL, ["sh", ...words]] : [python, words];
    if (exceedsArgMax(programWords, process.env)) return cannotRun(python, E2BIG);
    process.execve?.(program, programWords, process.env);
  } catch (error) {
    return cannotRun(python, errnoOf(error));
  }
  return 127;
}
