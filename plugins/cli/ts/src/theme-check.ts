import type { Io } from "./cli-command.ts";
import * as files from "./config-files.ts";
import { ConfigError, type Places } from "./config-files.ts";
import { dumps, Float, type JsonObject, type Value } from "./json.ts";
import { loads } from "./pyjson.ts";
import { PyOSError } from "./pyos.ts";
import { search } from "./pyregex.ts";
import { isDict, isFinite, isList, isNumber, isStr, lessOrEqual, show } from "./pyvalue.ts";
import { didYouMean, formatPath, type Path, Problem, validate } from "./schema-check.ts";

const CHANNEL = "\\s*(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\s*";
const ALPHA = "\\s*(?:0|1|0?\\.[0-9]+|1\\.0+)\\s*";
const COLOUR = `^(?:#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8}|rgb\\(${CHANNEL},${CHANNEL},${CHANNEL}\\)|rgba\\(${CHANNEL},${CHANNEL},${CHANNEL},${ALPHA}\\))$`;
const COLOUR_RULE = "a colour (#RGB, #RRGGBB, #RRGGBBAA, or rgb or rgba with r, g, b from 0 to 255 and a from 0 to 1)";
const FAMILY_RULE = "must be a font family name (1 to 64 characters, no space at either end)";
const SYMBOL_RULE = "an SF Symbol name (lowercase letters, digits and dots)";
export const LOOK_NOUNS: Record<string, string> = { "type.sizes": "text size", "type.weights": "weight", "metrics.radius": "radius" };

const BUILT_IN_LOOK_JSON =
  '{"type":{"type":"object","properties":{"family":{"type":"string","pattern":"^\\\\S(.{0,62}\\\\S)?$"},"mono":{"type":"string","pattern":"^\\\\S(.{0,62}\\\\S)?$","default":"Menlo"},"scale":{"type":"number","minimum":0.85,"maximum":1.3,"default":1},"sizes":{"type":"object","properties":{"badge":{"type":"number","minimum":7,"maximum":14,"default":9},"tiny":{"type":"number","minimum":8,"maximum":16,"default":10},"caption":{"type":"number","minimum":8,"maximum":18,"default":11},"small":{"type":"number","minimum":9,"maximum":19,"default":12},"body":{"type":"number","minimum":10,"maximum":21,"default":13},"title":{"type":"number","minimum":11,"maximum":24,"default":15},"large":{"type":"number","minimum":13,"maximum":27,"default":17}},"additionalProperties":false},"weights":{"type":"object","properties":{"regular":{"enum":["100","200","300","400","500","600","700","800","900",100,200,300,400,500,600,700,800,900],"default":"400"},"medium":{"enum":["100","200","300","400","500","600","700","800","900",100,200,300,400,500,600,700,800,900],"default":"500"},"semibold":{"enum":["100","200","300","400","500","600","700","800","900",100,200,300,400,500,600,700,800,900],"default":"600"},"bold":{"enum":["100","200","300","400","500","600","700","800","900",100,200,300,400,500,600,700,800,900],"default":"700"}},"additionalProperties":false}},"additionalProperties":false},"metrics":{"type":"object","properties":{"rowHeight":{"type":"number","minimum":24,"maximum":56,"default":34},"rowGap":{"type":"number","minimum":0,"maximum":12,"default":3},"pinnedHeight":{"type":"number","minimum":28,"maximum":72,"default":41},"sidebarWidth":{"type":"number","minimum":160,"maximum":400},"radius":{"type":"object","properties":{"row":{"type":"number","minimum":0,"maximum":24,"default":10},"pinned":{"type":"number","minimum":0,"maximum":24,"default":10},"tile":{"type":"number","minimum":0,"maximum":24,"default":8},"control":{"type":"number","minimum":0,"maximum":12,"default":4},"toolbar":{"type":"number","minimum":0,"maximum":24,"default":7},"panel":{"type":"number","minimum":0,"maximum":28,"default":12},"sheet":{"type":"number","minimum":0,"maximum":32,"default":16}},"additionalProperties":false}},"additionalProperties":false},"layout":{"type":"object","properties":{"hide":{"type":"array","items":{"type":"string","enum":["pinned","newTab","addressField","navButtons","sidebarButton","downloads","profile"]},"default":[]},"addressField":{"type":"string","enum":["top","bottom"],"default":"top"},"newTab":{"type":"string","enum":["top","bottom"]}},"additionalProperties":false},"icons":{"type":"object","propertyNames":{"type":"string","pattern":"^[a-z0-9]+(\\\\.[a-z0-9]+)*$"},"additionalProperties":{"type":"string","pattern":"^[a-z0-9]+(\\\\.[a-z0-9]+)*$"},"default":{}}}';

let builtInLook: JsonObject | undefined;

function builtIn(): JsonObject {
  builtInLook ??= loads(BUILT_IN_LOOK_JSON) as JsonObject;
  return builtInLook;
}

function numberRange(role: string, spec: Value | undefined): [Value, Value] | undefined {
  if (isDict(spec) && isNumber(spec.get("minimum")) && isNumber(spec.get("maximum"))) return [spec.get("minimum") as Value, spec.get("maximum") as Value];
  if (role === "grain" || role.endsWith("Opacity")) return [0n, 1n];
  if (role.endsWith("Radius")) return [0n, 100n];
  return undefined;
}

function isColour(value: Value | undefined): boolean {
  return typeof value === "string" && search(COLOUR, false, value);
}

function roleKind(sample: Value | undefined): string | undefined {
  if (typeof sample === "string") return "colour";
  if (isNumber(sample)) return "number";
  if (isList(sample)) return "pair";
  return undefined;
}

function inRange(value: Value, span: [Value, Value] | undefined): boolean {
  if (!isNumber(value) || !isFinite(value)) return false;
  return span === undefined || (lessOrEqual(span[0] as bigint, value) && lessOrEqual(value, span[1] as bigint));
}

function roleProblem(role: string, value: Value, kind: string, spec: Value | undefined): string | undefined {
  if (kind === "colour") return isColour(value) ? undefined : `must be ${COLOUR_RULE}`;
  if (kind === "pair") {
    const ok = isList(value) && value.length === 2 && value.every(isColour);
    return ok ? undefined : `must be two colours, each ${COLOUR_RULE}`;
  }
  const span = numberRange(role, spec);
  if (inRange(value, span)) return undefined;
  return span === undefined ? "must be a number" : `must be a number from ${show(span[0])} to ${show(span[1])}`;
}

export function lookSpecs(schema: JsonObject | undefined): JsonObject {
  if (schema === undefined) return builtIn();
  const properties = schema.get("properties");
  const found: JsonObject = new Map();
  if (!isDict(properties)) return found;
  for (const [key, spec] of properties) if (key !== "$schema" && !files.MODES.includes(key) && isDict(spec)) found.set(key, spec);
  return found;
}

export function themeKeys(schema: JsonObject | undefined): string[] {
  return [...files.MODES, ...lookSpecs(schema).keys()];
}

export function asJsValue(value: Value): Value {
  if (value instanceof Float && Number.isFinite(value.value) && Number.isInteger(value.value)) return BigInt(value.value);
  return value;
}

function jsText(value: Value): string {
  return dumps(asJsValue(value), "compact");
}

function patternOf(spec: Value | undefined): string | undefined {
  const pattern = isDict(spec) ? spec.get("pattern") : undefined;
  return typeof pattern === "string" ? pattern : undefined;
}

function matches(pattern: string | undefined, value: Value | undefined): boolean {
  return typeof value === "string" && (pattern === undefined || search(pattern, false, value));
}

export function unknownKey(name: string, noun: string, key: string, known: string[]): string {
  const hint = didYouMean(key, known) || ` (${known.join(", ")})`;
  return `${name} isn't a ${noun} key${hint}`;
}

function lookProblems(spec: JsonObject, value: Value, path: Path): Problem[] {
  const name = formatPath(path);
  const kind = spec.get("type");
  const properties = spec.get("properties");
  if (isDict(properties)) {
    if (!isDict(value)) return [new Problem(path, `${name} must be an object`)];
    const problems: Problem[] = [];
    const noun = LOOK_NOUNS[name] ?? String(path.at(-1));
    for (const [key, given] of value) {
      const child = properties.get(key);
      if (!isDict(child)) {
        problems.push(new Problem([...path, key], unknownKey(`${name}.${key}`, noun, key, [...properties.keys()])));
        continue;
      }
      problems.push(...lookProblems(child, given, [...path, key]));
    }
    return problems;
  }
  if (kind === "object") {
    if (!isDict(value)) return [new Problem(path, `${name} must be an object of SF Symbol names`)];
    const names = patternOf(spec.get("propertyNames"));
    const replacements = patternOf(spec.get("additionalProperties"));
    const problems: Problem[] = [];
    for (const [key, given] of value) {
      if (!matches(names, key)) problems.push(new Problem([...path, key], `${name} has ${jsText(key)}, which isn't ${SYMBOL_RULE}`));
      else if (!matches(replacements, given)) problems.push(new Problem([...path, key], `${name}.${key} must be ${SYMBOL_RULE}`));
    }
    return problems;
  }
  if (kind === "array") {
    const itemsValue = spec.get("items");
    const items = isDict(itemsValue) ? itemsValue : new Map<string, Value>();
    const enumValue = items.get("enum");
    const parts = (isList(enumValue) ? enumValue : []).filter(isStr);
    const listed = parts.join(", ");
    if (!isList(value)) return [new Problem(path, `${name} must be a list of parts (${listed})`)];
    return value.filter((item) => !(isStr(item) && parts.includes(item))).map((item) => new Problem(path, `${name} has ${jsText(item)}, which isn't a part (${listed})`));
  }
  if (kind === "number") {
    const low = spec.get("minimum");
    const high = spec.get("maximum");
    const bounded = isNumber(low) && isNumber(high);
    if (inRange(value, bounded ? [low, high] : undefined)) return [];
    return [new Problem(path, bounded ? `${name} must be a number from ${show(low)} to ${show(high)}` : `${name} must be a number`)];
  }
  const enumValue = spec.get("enum");
  if (kind === "string" && isList(enumValue)) {
    const options = enumValue.filter(isStr);
    return isStr(value) && options.includes(value) ? [] : [new Problem(path, `${name} must be one of ${options.join(", ")}`)];
  }
  if (kind === "string") return matches(patternOf(spec), value) ? [] : [new Problem(path, `${name} ${FAMILY_RULE}`)];
  if (kind === undefined && isList(enumValue)) {
    const weights = enumValue.filter(isStr);
    const weight = isNumber(value) ? jsNumberText(asJsValue(value)) : value;
    if (isStr(weight) && weights.includes(weight)) return [];
    return weights.length > 0 ? [new Problem(path, `${name} must be a weight from "${weights[0]}" to "${weights.at(-1)}" in steps of 100`)] : validate(value, spec, path, false);
  }
  return validate(value, spec, path, false);
}

function jsNumberText(value: Value): string {
  return show(value);
}

export function themeProblems(document: Value, schema: JsonObject | undefined): Problem[] {
  if (!isDict(document)) return [new Problem([], "must be an object")];
  const problems: Problem[] = [];
  const keys = themeKeys(schema);
  for (const key of document.keys()) if (key !== "$schema" && !keys.includes(key)) problems.push(new Problem([key], unknownKey(key, "theme", key, keys)));
  for (const mode of files.MODES) {
    if (!document.has(mode)) continue;
    const roles = document.get(mode);
    if (!isDict(roles)) {
      problems.push(new Problem([mode], `${mode} must be an object of colour roles`));
      continue;
    }
    const specs = files.roleSpecs(schema, mode);
    for (const [role, value] of roles) {
      const path = [mode, role];
      const spec = schema !== undefined ? specs.get(role) : undefined;
      let kind: string | undefined;
      if (schema !== undefined) kind = isDict(spec) ? roleKind(spec.get("default")) : undefined;
      else kind = role !== "dark" ? roleKind(value) : undefined;
      if (kind === undefined) {
        const suggestion = schema !== undefined ? didYouMean(role, [...specs.keys()].filter((name) => name !== "dark")) : "";
        problems.push(new Problem(path, `${mode}.${role} isn't a colour role${suggestion}`));
        continue;
      }
      const problem = roleProblem(role, value, kind, spec);
      if (problem) problems.push(new Problem(path, `${mode}.${role} ${problem}`));
    }
  }
  for (const [key, spec] of lookSpecs(schema)) if (document.has(key)) problems.push(...lookProblems(spec as JsonObject, document.get(key) as Value, [key]));
  return problems;
}

export function checkThemeFile(where: Places, path: string, schema: JsonObject | undefined): Problem[] {
  let document: Value;
  try {
    document = files.readJson(path, where.show(path));
  } catch (error) {
    if (error instanceof PyOSError && error.notFound) return [new Problem([], "doesn't exist")];
    if (error instanceof ConfigError) return [new Problem([], error.message)];
    throw error;
  }
  return themeProblems(document, schema);
}

export function report(results: [string, string, Problem[]][], warnings: string[], asJson: boolean, io: Io): number {
  const ok = results.every(([, , problems]) => problems.length === 0);
  if (asJson) {
    const shaped = new Map<string, Value>([
      ["ok", ok],
      [
        "files",
        results.map(
          ([path, , problems]) =>
            new Map<string, Value>([
              ["file", path],
              ["problems", problems.map((problem) => problem.toDict())],
            ]),
        ),
      ],
      ["warnings", warnings],
    ]);
    io.say(dumps(shaped, "indented"));
    return ok ? 0 : 1;
  }
  for (const warning of warnings) io.complain(`warning: ${warning}`);
  for (const [, label, problems] of results) {
    if (problems.length === 0) io.say(`${label}: ok`);
    for (const problem of problems) io.say(problem.message.startsWith(label) ? problem.message : `${label}: ${problem.message}`);
  }
  return ok ? 0 : 1;
}
