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

export async function handOff(argv: string[], python: string | null = bundledPython()): Promise<number> {
  if (python === null || !existsSync(python)) {
    complain(`ardia: this command runs on the bundled Python, which isn't there (${python ?? "next to this ardia"})\n`);
    return 127;
  }
  try {
    if (decodedLossily(argv)) {
      const raw = await import("./raw-handoff.ts");
      const words = raw.rawWords(python);
      if (words !== undefined) raw.execWithRawBytes(python, words);
    }
    process.execve?.(python, [python, "-I", "-m", "ardia_cli", ...argv], process.env);
  } catch (error) {
    const errno = Math.abs((error as NodeJS.ErrnoException).errno ?? 0);
    const { DARWIN_ERRORS } = await import("./errnos.ts");
    complain(`ardia: couldn't run ${python}: ${DARWIN_ERRORS[errno] ?? (error instanceof Error ? error.message : String(error))}\n`);
  }
  return 127;
}
