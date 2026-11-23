import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function withoutGroupWrite(root: string): void {
  const info = lstatSync(root);
  if (info.isSymbolicLink()) return;
  chmodSync(root, info.mode & 0o7755);
  if (!info.isDirectory()) return;
  for (const name of readdirSync(root)) withoutGroupWrite(join(root, name));
}
