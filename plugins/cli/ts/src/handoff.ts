import { existsSync, realpathSync } from "node:fs";
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

export function handOff(argv: string[], python: string | null = bundledPython()): number {
  if (python === null || !existsSync(python)) {
    const place = python ?? "next to this ardia";
    process.stderr.write(`ardia: this command runs on the bundled Python, which isn't there (${place})\n`);
    return 127;
  }
  try {
    process.execve?.(python, [python, "-I", "-m", "ardia_cli", ...argv], process.env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ardia: couldn't run ${python}: ${reason}\n`);
  }
  return 127;
}
