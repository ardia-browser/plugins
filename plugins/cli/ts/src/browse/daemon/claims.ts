import { createHash } from "node:crypto";
import { type JsonObject, type Value } from "../../json.ts";
import { strOf } from "../../py.ts";
import { BrowseError } from "../daemon-errors.ts";
import { closeFd, listNames, lockWithin, lockHeld, openPrivateDirAt, openPrivateFile, readPrivateJson, unlinkQuietly, writePrivateJson } from "../paths.ts";

function nameOf(targetId: string): string {
  return `${createHash("sha256").update(Buffer.from(targetId, "utf8")).digest("hex").slice(0, 24)}.json`;
}

function locked<T>(browseFd: number, run: (folder: number) => T): T {
  const folder = openPrivateDirAt(browseFd, "claims");
  let lock: number | undefined;
  try {
    lock = openPrivateFile(".lock", folder);
    lockWithin(lock, "The tab claims");
    return run(folder);
  } finally {
    closeFd(lock);
    closeFd(folder);
  }
}

function record(value: Value | undefined): JsonObject | null {
  return value instanceof Map && value.size > 0 ? value : null;
}

function kindsOf(current: JsonObject): string[] {
  const kinds = current.get("kinds");
  return Array.isArray(kinds) ? kinds.filter((kind): kind is string => typeof kind === "string") : [];
}

export function claim(browseFd: number, key: string, session: string, targetId: string, kind: string): void {
  locked(browseFd, (folder) => {
    const name = nameOf(targetId);
    const current = record(readPrivateJson(name, folder));
    const owner = current?.get("owner");
    if (current && owner !== key && lockHeld(`${strOf(owner ?? null)}.lock`, browseFd)) {
      const holder = strOf(current.get("session") ?? null);
      throw new BrowseError(
        `Session ${holder} is already capturing or routing this tab; stop it there first (\`ardia browse --session ${holder} ...\`)`,
        null,
        "tab_owned",
      );
    }
    const kinds = new Set(current && owner === key ? kindsOf(current) : []);
    kinds.add(kind);
    writePrivateJson(
      name,
      folder,
      new Map<string, Value>([
        ["owner", key],
        ["session", session],
        ["target", targetId],
        ["kinds", [...kinds].sort()],
      ]),
    );
  });
}

export function release(browseFd: number, key: string, targetId: string | null = null, kind: string | null = null): void {
  locked(browseFd, (folder) => {
    for (const entry of listNames(folder)) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      const current = record(readPrivateJson(entry, folder));
      if (!current || current.get("owner") !== key) continue;
      if (targetId !== null && current.get("target") !== targetId) continue;
      const kinds = kindsOf(current).filter((value) => kind !== null && value !== kind);
      if (kinds.length > 0) writePrivateJson(entry, folder, new Map([...current, ["kinds", kinds]]));
      else unlinkQuietly(entry, folder);
    }
  });
}
