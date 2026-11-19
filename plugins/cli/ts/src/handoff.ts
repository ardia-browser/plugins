import { closeSync, existsSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DARWIN_ERRORS } from "./errnos.ts";

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

export function handOff(argv: string[], python: string | null = bundledPython()): number {
  if (python === null || !existsSync(python)) {
    const place = python ?? "next to this ardia";
    process.stderr.write(`ardia: this command runs on the bundled Python, which isn't there (${place})\n`);
    return 127;
  }
  try {
    process.execve?.(python, [python, "-I", "-m", "ardia_cli", ...argv], process.env);
  } catch (error) {
    const errno = Math.abs((error as NodeJS.ErrnoException).errno ?? 0);
    const reason = DARWIN_ERRORS[errno] ?? (error instanceof Error ? error.message : String(error));
    process.stderr.write(`ardia: couldn't run ${python}: ${reason}\n`);
  }
  return 127;
}
