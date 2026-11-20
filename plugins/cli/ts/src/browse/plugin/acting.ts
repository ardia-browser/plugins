import { canonical } from "../daemon/names.ts";
import { parse } from "../commands/parse.ts";

export const FIND_ACTIONS = ["click", "fill", "type", "press", "check", "uncheck", "select", "hover", "focus", "dblclick", "text"];
export const FIND_LOCATORS = ["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"];
const ACTING = new Set(["click", "fill", "type", "press", "scroll", "select", "check", "uncheck", "hover", "dblclick"]);

export function findArguments(given: string[], name: string | null): [string, string[], string | null] {
  let locator = given[0] as string;
  const args = given.slice(1);
  if (locator.includes("=") && FIND_LOCATORS.includes(locator.slice(0, locator.indexOf("=")))) {
    args.unshift(locator.slice(locator.indexOf("=") + 1));
    locator = locator.slice(0, locator.indexOf("="));
  }
  if (locator === "role" && args[0] !== undefined && FIND_ACTIONS.includes(args[0]) && args.length > 1 && !FIND_ACTIONS.includes(args[1] as string)) {
    [args[0], args[1]] = [args[1] as string, args[0]];
  }
  if (locator === "role" && name === null && args.length >= 2 && !FIND_ACTIONS.includes(args[1] as string)) name = args.splice(1, 1)[0] as string;
  return [locator, args, name];
}

export function findAction(argv: string[]): string {
  const [options, given] = parse(argv, { "--name": "value", "--exact": "bool", "--partial": "bool", "--no-humanize": "bool" });
  if (given.length === 0) return "click";
  const [locator, args] = findArguments(given, (options["name"] as string | undefined) ?? null);
  return (locator === "nth" ? args[2] : args[1]) ?? "click";
}

export function actingStep(argv: readonly unknown[]): boolean {
  const name = canonical(String(argv[0] ?? ""));
  if (ACTING.has(name)) return true;
  if (name !== "find") return false;
  try {
    return findAction(argv.slice(1).map(String)) !== "text";
  } catch {
    return true;
  }
}
