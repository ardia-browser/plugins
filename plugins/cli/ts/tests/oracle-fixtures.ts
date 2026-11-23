import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const ORACLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "oracle");

export function oracleText(name: string): string {
  const plain = path.join(ORACLE_DIR, `${name}.json`);
  if (existsSync(plain)) return readFileSync(plain, "utf8");
  return gunzipSync(readFileSync(`${plain}.gz`)).toString("utf8");
}

export function oracle<T>(name: string): T {
  return JSON.parse(oracleText(name)) as T;
}

export type Tagged = null | boolean | string | { kind: "int" | "float"; literal: string } | Tagged[] | { pairs: [string, Tagged][] };

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const CONSTANTS: [string, Tagged][] = [
  ["true", true],
  ["false", false],
  ["null", null],
  ["NaN", { kind: "float", literal: "NaN" }],
  ["Infinity", { kind: "float", literal: "Infinity" }],
  ["-Infinity", { kind: "float", literal: "-Infinity" }],
];

export function parseTagged(text: string): Tagged {
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at] as string)) at += 1;
  };
  const expect = (char: string) => {
    if (text[at] !== char) throw new Error(`expected ${char} at ${at} of ${text.slice(at, at + 40)}`);
    at += 1;
  };
  const string = (): string => {
    let end = at + 1;
    while (text[end] !== '"') {
      if (end >= text.length) throw new Error(`unterminated string at ${at}`);
      end += text[end] === "\\" ? 2 : 1;
    }
    const found = JSON.parse(text.slice(at, end + 1)) as string;
    at = end + 1;
    return found;
  };
  const value = (): Tagged => {
    space();
    const char = text[at];
    if (char === "{") {
      at += 1;
      const pairs: [string, Tagged][] = [];
      space();
      if (text[at] === "}") {
        at += 1;
        return { pairs };
      }
      for (;;) {
        space();
        const key = string();
        space();
        expect(":");
        pairs.push([key, value()]);
        space();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        expect("}");
        return { pairs };
      }
    }
    if (char === "[") {
      at += 1;
      const items: Tagged[] = [];
      space();
      if (text[at] === "]") {
        at += 1;
        return items;
      }
      for (;;) {
        items.push(value());
        space();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        expect("]");
        return items;
      }
    }
    if (char === '"') return string();
    for (const [word, meaning] of CONSTANTS) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return meaning;
      }
    }
    NUMBER.lastIndex = at;
    const number = NUMBER.exec(text);
    if (number === null) throw new Error(`no JSON value at ${at}: ${text.slice(at, at + 40)}`);
    at += number[0].length;
    return { kind: number[1] === undefined && number[2] === undefined ? "int" : "float", literal: number[0] };
  };
  const found = value();
  space();
  if (at !== text.length) throw new Error(`trailing text at ${at}`);
  return found;
}

export function taggedText(value: Tagged): string {
  if (Array.isArray(value)) return `[${value.map(taggedText).join(",")}]`;
  if (value !== null && typeof value === "object") {
    if ("pairs" in value) return `{${value.pairs.map(([key, item]) => `${JSON.stringify(key)}:${taggedText(item)}`).join(",")}}`;
    return value.literal;
  }
  return JSON.stringify(value);
}

export function taggedDifference(a: Tagged, b: Tagged, where = ""): string | null {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${where}: list vs not a list`;
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if (index >= a.length || index >= b.length) return `${where}[${index}]: lengths ${a.length} vs ${b.length}`;
      const inner = taggedDifference(a[index] as Tagged, b[index] as Tagged, `${where}[${index}]`);
      if (inner !== null) return inner;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    if ("pairs" in a && "pairs" in b) {
      if (a.pairs.length !== b.pairs.length) return `${where}: keys ${JSON.stringify(a.pairs.map(([key]) => key))} vs ${JSON.stringify(b.pairs.map(([key]) => key))}`;
      for (let index = 0; index < a.pairs.length; index += 1) {
        const [keyA, valueA] = a.pairs[index] as [string, Tagged];
        const [keyB, valueB] = b.pairs[index] as [string, Tagged];
        if (keyA !== keyB) return `${where}: key ${index} is ${JSON.stringify(keyA)} vs ${JSON.stringify(keyB)}`;
        const inner = taggedDifference(valueA, valueB, `${where}.${keyA}`);
        if (inner !== null) return inner;
      }
      return null;
    }
    if ("kind" in a && "kind" in b) return a.kind === b.kind && a.literal === b.literal ? null : `${where}: ${a.kind} ${a.literal} vs ${b.kind} ${b.literal}`;
    return `${where}: object vs number`;
  }
  return a === b ? null : `${where}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

export function caseDifferences(casesText: string, expectedText: string, actualText: string, show = 3): { count: number; differing: number; shown: string[] } {
  const cases = parseTagged(casesText);
  if (!Array.isArray(cases)) throw new Error("cases aren't a list");
  const expected = parseTagged(expectedText);
  const actual = parseTagged(actualText);
  if (!Array.isArray(expected) || !Array.isArray(actual)) throw new Error("answers aren't lists");
  const shown: string[] = [];
  let differing = 0;
  for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
    const difference = index < expected.length && index < actual.length ? taggedDifference(expected[index] as Tagged, actual[index] as Tagged) : "missing answer";
    if (difference === null) continue;
    differing += 1;
    if (shown.length < show) {
      shown.push(
        `case ${index}: input ${taggedText(cases[index] ?? null).slice(0, 300)}\n  ${difference.slice(0, 300)}\n  python: ${taggedText(expected[index] ?? null).slice(0, 400)}\n  ts:     ${taggedText(actual[index] ?? null).slice(0, 400)}`,
      );
    }
  }
  return { count: cases.length, differing, shown };
}

function answered(script: string, name: string, cases: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, name], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`${path.basename(script)} ${name} exited ${code}: ${Buffer.concat(err).toString("utf8").slice(-2000)}`));
    });
    child.stdin.end(cases);
  });
}

export type FrozenFunctions = { count: number; functions: Record<string, { cases: string; expected: string }> };

export async function frozenFunctionReports(frozen: FrozenFunctions, script: string, parallel = 6): Promise<{ reports: string[]; functions: number; cases: number }> {
  const names = Object.keys(frozen.functions);
  const reports: string[] = [];
  let cases = 0;
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++] as string;
      const one = frozen.functions[name] as { cases: string; expected: string };
      const { count, differing, shown } = caseDifferences(one.cases, one.expected, await answered(script, name, one.cases));
      cases += count;
      if (differing > 0) reports.push(`${name}: ${count - differing} of ${count} cases agree\n${shown.join("\n")}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return { reports: reports.sort(), functions: names.length, cases };
}
