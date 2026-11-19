import { inert, jsonSafe, shown } from "../../src/printable.ts";

type Twin = (...args: never[]) => unknown;

const FUNCTIONS: Record<string, Twin> = {
  "printable.shown": shown as Twin,
  "printable.inert": inert as Twin,
  "printable.json_safe": jsonSafe as Twin,
};

function errorName(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function main(): Promise<number> {
  const name = process.argv[2] ?? "";
  const twin = FUNCTIONS[name];
  if (!twin) {
    process.stderr.write(`oracle.ts: no TypeScript twin registered for ${JSON.stringify(name)}\n`);
    return 2;
  }
  const cases = JSON.parse(await Bun.stdin.text()) as unknown[][];
  const results = cases.map((args) => {
    try {
      return { ok: twin(...(args as never[])) ?? null };
    } catch (error) {
      return { error: errorName(error) };
    }
  });
  process.stdout.write(JSON.stringify(results));
  return 0;
}

process.exitCode = await main();
