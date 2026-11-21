import { opaqueSlot } from "./opaque.ts";
import { decimalDigit } from "../pystr.ts";
import { isNumberSpace, isSpace, strip } from "../py.ts";
import { BOOL_FLAGS, COMMAND_FLAGS, COMMAND_NAME, COMMAND_OWNS, LAUNCH_HINTS, LAUNCH_ONLY, VALUE_FLAGS } from "./tables.ts";

const SHARED_VALUE_FLAGS = ["--port", "--ws", "--data-dir", "--timeout"];
const BROWSE_SHARED_FLAGS = ["--port", "--ws", "--data-dir", "--json"];
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND_PATTERN = new RegExp(COMMAND_NAME);
const PY_INT_MAX_STR_DIGITS = 4300;

const COMMAND_LAUNCH_NAMES: Readonly<Record<string, readonly string[]>> = { wait: ["--state"] };

export class Usage extends Error {
  constructor(
    message: string,
    readonly found?: Found,
  ) {
    super(message);
  }
}

export class Found {
  readonly values = new Map<string, string>();
  readonly flags = new Map<string, boolean>();
  enable: string[] | undefined;
  initScript: string[] | undefined;

  value(key: string): string | undefined {
    return this.values.get(key);
  }

  flag(key: string): boolean | undefined {
    return this.flags.get(key);
  }

  namesEndpoint(): boolean {
    return ["ws", "port", "cdp"].some((key) => this.values.has(key));
  }
}

export function truthy(value: string | undefined): boolean {
  return !["", "0", "false", "no", "off"].includes(strip(value ?? "", isSpace).toLowerCase());
}

function keyOf(name: string): string {
  return name.replace(/^-+/, "").replaceAll("-", "_");
}

export function splitGlobals(argv: readonly string[]): { found: Found; rest: string[] } {
  const found = new Found();
  const rest: string[] = [];
  const positionals: string[] = [];
  let command: string | undefined;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    index += 1;
    if (token === "--") {
      rest.push(...argv.slice(index - 1));
      break;
    }
    if (command !== undefined && opaqueSlot(command, positionals)) {
      positionals.push(token);
      rest.push(token);
      continue;
    }
    const split = token.startsWith("--") && token.includes("=");
    const name = split ? token.slice(0, token.indexOf("=")) : token;
    let inline = split ? token.slice(token.indexOf("=") + 1) : undefined;
    const owned = (COMMAND_OWNS[command ?? ""] ?? []).includes(name);
    if (VALUE_FLAGS.includes(name) && !owned) {
      if (inline === undefined) {
        if (index >= argv.length) throw new Usage(`${name} needs a value`, found);
        inline = argv[index] as string;
        index += 1;
      }
      if (name === "--enable") (found.enable ??= []).push(...inline.split(","));
      else if (name === "--init-script") (found.initScript ??= []).push(inline);
      else found.values.set(keyOf(name), inline);
      continue;
    }
    if (BOOL_FLAGS.includes(name) && !owned) {
      found.flags.set(keyOf(name), inline === undefined ? true : truthy(inline));
      continue;
    }
    if (command !== undefined && COMMAND_LAUNCH_NAMES[command]?.includes(name)) {
      rest.push(token);
      continue;
    }
    const hint = LAUNCH_HINTS[name];
    if (hint !== undefined) throw new Usage(`${name} is a launch option agent-browser applies when it starts its own browser; ${hint}`, found);
    if (LAUNCH_ONLY.includes(name)) {
      throw new Usage(`${name} doesn't apply to Ardia: ardia browse drives the browser you're running, so launch options have no effect`, found);
    }
    if (command === undefined && !token.startsWith("-")) command = token;
    else if (command !== undefined && !token.startsWith("-")) positionals.push(token);
    rest.push(token);
  }
  return { found, rest };
}

function jsonFlag(browse: readonly string[]): boolean | undefined {
  let found: Found | undefined;
  try {
    found = splitGlobals(browse).found;
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    found = error.found;
  }
  return found?.flag("json");
}

export function plainJsonIntent(tokens: readonly string[]): boolean {
  let wanted: boolean | undefined;
  for (const token of tokens) {
    if (token === "--") break;
    if (token === "--json") wanted = true;
    else if (token.startsWith("--json=")) wanted = truthy(token.slice("--json=".length));
  }
  return Boolean(wanted) || truthy(process.env.AGENT_BROWSER_JSON);
}

export function refusalJsonIntent(browse: readonly string[]): boolean {
  try {
    splitGlobals(browse);
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    return plainJsonIntent(browse);
  }
  return jsonIntent(browse);
}

export function jsonIntent(browse: readonly string[]): boolean {
  return Boolean(jsonFlag(browse)) || truthy(process.env.AGENT_BROWSER_JSON);
}

export function jsonIntentOfArgv(argv: readonly string[]): boolean {
  let leading = false;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (SHARED_VALUE_FLAGS.includes(token.split("=")[0] as string)) {
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    if (token !== "--json") break;
    leading = true;
    index += 1;
  }
  if (argv[index] !== "browse") return leading || truthy(process.env.AGENT_BROWSER_JSON);
  return (jsonFlag(argv.slice(index + 1)) ?? leading) || truthy(process.env.AGENT_BROWSER_JSON);
}

export function hoist(argv: readonly string[]): string[] | undefined {
  const leading: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=")[0] as string;
    if (SHARED_VALUE_FLAGS.includes(name)) {
      if (token.includes("=")) {
        leading.push(token);
        index += 1;
        continue;
      }
      if (index + 1 >= argv.length) return undefined;
      leading.push(token, argv[index + 1] as string);
      index += 2;
      continue;
    }
    if (token === "--json") {
      leading.push(token);
      index += 1;
      continue;
    }
    break;
  }
  if (argv[index] !== "browse") return undefined;
  if (leading.some((token) => token.startsWith("--") && !BROWSE_SHARED_FLAGS.includes(token.split("=")[0] as string))) return undefined;
  const browse = [...leading, ...argv.slice(index + 1)];
  let found: Found;
  try {
    found = splitGlobals(browse).found;
  } catch (error) {
    if (error instanceof Usage) return browse;
    throw error;
  }
  if (found.namesEndpoint()) return browse;
  const ws = process.env.ARDIA_WS;
  if (ws) return ["--ws", ws, ...browse];
  const port = process.env.ARDIA_PORT;
  if (port) return ["--port", port, ...browse];
  return browse;
}

export function hoistFailure(argv: readonly string[]): { status: number; text: string } {
  let index = 0;
  const leading: string[] = [];
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=")[0] as string;
    if (SHARED_VALUE_FLAGS.includes(name)) {
      if (token.includes("=")) index += 1;
      else if (index + 1 >= argv.length) return { status: 2, text: `ardia: ${name} needs a value\n` };
      else index += 2;
      leading.push(name);
      continue;
    }
    if (token !== "--json") break;
    index += 1;
  }
  const refused = leading.find((name) => !BROWSE_SHARED_FLAGS.includes(name)) ?? "";
  return { status: 1, text: `✗ ardia browse doesn't take ${refused}\n` };
}

export function commandName(browse: readonly string[]): string {
  let rest: string[];
  try {
    rest = splitGlobals(browse).rest;
  } catch (error) {
    if (error instanceof Usage) return "other";
    throw error;
  }
  const first = rest[0] ?? "help";
  const name = ({ "--help": "help", "-h": "help", "--version": "version", "-V": "version" } as Record<string, string>)[first] ?? first;
  return COMMAND_PATTERN.test(name) ? name : "other";
}

export function allowedFlags(name: string): string[] {
  return [...VALUE_FLAGS, ...BOOL_FLAGS, ...(name === "other" ? [] : (COMMAND_FLAGS[name] ?? []))];
}

export function checkName(kind: string, name: string): string | undefined {
  const body = name.endsWith("\n") ? name.slice(0, -1) : name;
  return SESSION_NAME.test(body) ? undefined : `${kind} must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit`;
}

function decimalValue(ch: string): string | undefined {
  if (ch >= "0" && ch <= "9") return ch;
  const digit = decimalDigit(ch);
  return digit === undefined ? undefined : String(digit);
}

function asciiDigits(text: string): string | undefined {
  let out = "";
  for (const ch of text) {
    const digit = decimalValue(ch);
    if (digit === undefined) return undefined;
    out += digit;
  }
  return out;
}

function underscored(text: string): string | undefined {
  if (text === "" || text.startsWith("_") || text.endsWith("_") || text.includes("__")) return undefined;
  return asciiDigits(text.replaceAll("_", ""));
}

export type PyInt = { value: bigint } | { invalid: true };

export function pythonInt(text: string): PyInt {
  const body = strip(text, isNumberSpace);
  const sign = body.startsWith("-") ? -1n : 1n;
  const unsigned = body.startsWith("-") || body.startsWith("+") ? body.slice(1) : body;
  const digits = underscored(unsigned);
  if (digits === undefined || digits.length > PY_INT_MAX_STR_DIGITS) return { invalid: true };
  return { value: sign * BigInt(digits) };
}

export function pythonFloat(text: string): number | undefined {
  const body = strip(text, isNumberSpace);
  const sign = body.startsWith("-") ? -1 : 1;
  const unsigned = (body.startsWith("-") || body.startsWith("+") ? body.slice(1) : body).toLowerCase();
  if (unsigned === "inf" || unsigned === "infinity") return sign * Number.POSITIVE_INFINITY;
  if (unsigned === "nan") return Number.NaN;
  const shape = /^(?:([^.eE]*)(?:\.([^.eE]*))?)(?:[eE]([+-]?)([^.eE+-]*))?$/u.exec(unsigned);
  if (shape === null) return undefined;
  const [, whole = "", fraction, expSign = "", exponent] = shape;
  const hasPoint = unsigned.includes(".");
  const wholeDigits = whole === "" ? "" : underscored(whole);
  const fractionDigits = fraction === undefined || fraction === "" ? "" : underscored(fraction);
  if (wholeDigits === undefined || fractionDigits === undefined || (wholeDigits === "" && fractionDigits === "")) return undefined;
  if (!hasPoint && fraction !== undefined) return undefined;
  let exponentDigits = "";
  if (exponent !== undefined) {
    const parsed = underscored(exponent);
    if (parsed === undefined) return undefined;
    exponentDigits = `e${expSign}${parsed}`;
  }
  return sign * Number(`${wholeDigits || "0"}.${fractionDigits || "0"}${exponentDigits}`);
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };

function decimalNumber(text: string): string | undefined {
  const point = text.indexOf(".");
  const whole = point < 0 ? text : text.slice(0, point);
  const fraction = point < 0 ? undefined : text.slice(point + 1);
  const wholeDigits = whole === "" ? undefined : asciiDigits(whole);
  const fractionDigits = fraction === undefined ? "" : fraction === "" ? undefined : asciiDigits(fraction);
  if (wholeDigits === undefined || fractionDigits === undefined) return undefined;
  return fraction === undefined ? wholeDigits : `${wholeDigits}.${fractionDigits}`;
}

function unitSplit(text: string, units: readonly string[]): [string, string | undefined] {
  for (const unit of units) {
    if (text.endsWith(unit) && decimalNumber(text.slice(0, -unit.length)) !== undefined) return [text.slice(0, -unit.length), unit];
  }
  return [text, undefined];
}

export type Duration = { ms: bigint } | { invalid: true } | { infinite: true };

export function parseDuration(value: string): Duration {
  const [number, unit] = unitSplit(strip(value, isSpace), ["ms", "s", "m", "h"]);
  const digits = decimalNumber(number);
  if (digits === undefined) return { invalid: true };
  const product = Number(digits) * (DURATION_UNITS[unit ?? "ms"] as number);
  if (!Number.isFinite(product)) return { infinite: true };
  return { ms: BigInt(Math.trunc(product)) };
}

export function secondsOf(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const [number, unit] = unitSplit(strip(text, isSpace), ["ms", "s", "m"]);
  const digits = decimalNumber(number);
  if (digits === undefined) return undefined;
  return Number(digits) * ({ ms: 0.001, s: 1, m: 60 } as Record<string, number>)[unit ?? "ms"]!;
}

export function plainNumber(text: string): boolean {
  return decimalNumber(text) !== undefined;
}
