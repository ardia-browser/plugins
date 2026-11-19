import { realpathSync } from "node:fs";
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
