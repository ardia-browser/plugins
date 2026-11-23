import { appendFileSync, statSync } from "node:fs";
import path from "node:path";
import { dumps, type JsonObject } from "../../../src/json.ts";
import { loads } from "../../../src/pyjson.ts";
import type { DaemonChoice } from "../../../src/browse/daemon/spawn.ts";

const RECORDED_REQUEST_KEYS = ["argv", "options", "stdin", "beside_if_busy", "patient_queue"];

function isDir(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

export function seededSpawn(config: JsonObject, _choice: DaemonChoice): [JsonObject, DaemonChoice] {
  const program = process.env["ARDIA_M3_TS_PROGRAM"];
  if (!program) throw new Error("the seeded client needs ARDIA_M3_TS_PROGRAM, the built ardia-ts that runs the daemon");
  const seeded = new Map(config);
  seeded.set("harness_seed", BigInt(process.env["ARDIA_M3_SEED"] ?? "0"));
  const home = process.env["HOME"];
  if (home && isDir(home)) appendFileSync(path.join(home, "spawn-config.jsonl"), `${dumps(seeded, "spaced")}\n`);
  return [seeded, { kind: "ts", program }];
}

function jsonObject(bytes: Uint8Array): { text: string; value: JsonObject } | null {
  const text = Buffer.from(bytes).toString("utf8").trim();
  try {
    const value = loads(text);
    return value instanceof Map ? { text, value } : null;
  } catch {
    return null;
  }
}

export function recordExchange(line: Uint8Array, answer: Uint8Array): void {
  const file = process.env["ARDIA_M3_ANSWERS"];
  if (!file) return;
  const wire = jsonObject(line);
  const answered = jsonObject(answer);
  if (wire === null || answered === null) return;
  const request = new Map(RECORDED_REQUEST_KEYS.map((key) => [key, wire.value.get(key) ?? null]));
  appendFileSync(file, `{"request": ${dumps(request, "spaced")}, "answer": ${answered.text}, "wire": ${wire.text}}\n`);
}
