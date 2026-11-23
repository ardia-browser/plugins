import { plugin } from "bun";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), "client-hooks.ts"));

type Patch = { file: RegExp; from: string; to: string; append: string };

const PATCHES: Patch[] = [
  {
    file: /\/src\/libc\.ts$/,
    from: "export function loadLibc(file: string = libcBeside()): void {",
    to: 'export function loadLibc(file: string = libcBeside(process.env["ARDIA_M3_TS_PROGRAM"])): void {',
    append: "",
  },
  {
    file: /\/src\/browse\/daemon\/spawn\.ts$/,
    from: "export function spawnDaemon(dir: number, key: string, config: JsonObject, choice: DaemonChoice): Spawned {",
    to: "function unseededSpawnDaemon(dir: number, key: string, config: JsonObject, choice: DaemonChoice): Spawned {",
    append: `import { seededSpawn as harnessSeededSpawn } from ${HOOKS};
export function spawnDaemon(dir: number, key: string, config: JsonObject, choice: DaemonChoice): Spawned {
  const [seeded, chosen] = harnessSeededSpawn(config, choice);
  return unseededSpawnDaemon(dir, key, seeded, chosen);
}
`,
  },
  {
    file: /\/src\/browse\/exchange\.ts$/,
    from: "export async function exchange(link: Link, line: Uint8Array, command: string, seconds: number, limit = MAX_RESPONSE): Promise<Buffer> {",
    to: "async function unrecordedExchange(link: Link, line: Uint8Array, command: string, seconds: number, limit = MAX_RESPONSE): Promise<Buffer> {",
    append: `import { recordExchange as harnessRecordExchange } from ${HOOKS};
export async function exchange(link: Link, line: Uint8Array, command: string, seconds: number, limit = MAX_RESPONSE): Promise<Buffer> {
  const answer = await unrecordedExchange(link, line, command, seconds, limit);
  harnessRecordExchange(line, answer);
  return answer;
}
`,
  },
];

plugin({
  name: "ardia-m3-seeded-client",
  setup(build) {
    for (const patch of PATCHES) {
      build.onLoad({ filter: patch.file }, (args) => {
        const source = readFileSync(args.path, "utf8");
        if (source.split(patch.from).length !== 2) throw new Error(`the seeded client can't patch ${args.path}: expected exactly one \`${patch.from}\``);
        return { contents: `${source.replace(patch.from, patch.to)}\n${patch.append}`, loader: "ts" };
      });
    }
  },
});
