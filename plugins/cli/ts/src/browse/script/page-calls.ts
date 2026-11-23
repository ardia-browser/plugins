import type { Page } from "../state/page.ts";

export const MAX_FUNCTION_SOURCE = 256 * 1024;

type PageRequest = Record<string, unknown>;

function argsOf(request: PageRequest): unknown[] {
  return Array.isArray(request["args"]) ? (request["args"] as unknown[]) : [];
}

function jsonArgs(request: PageRequest): string {
  return `JSON.parse(${JSON.stringify(JSON.stringify(argsOf(request)))})`;
}

function fnOf(request: PageRequest): string {
  return String(request["fn"] ?? "");
}

export function validEvaluate(request: PageRequest): string | null {
  const op = String(request["op"]);
  const fn = request["fn"];
  if (typeof fn !== "string" || !fn.trim()) return `page.${op}() takes a function`;
  if (fn.length > MAX_FUNCTION_SOURCE) return `the function given to page.${op}() is over ${MAX_FUNCTION_SOURCE / 1024} KB`;
  if (request["args"] !== undefined && !Array.isArray(request["args"])) return `page.${op}() takes its arguments after the function`;
  if (op === "evaluate" && request["isFunction"] !== true && argsOf(request).length > 0) {
    return "page.evaluate(expression) takes no arguments; pass a function to give it arguments: page.evaluate((a, b) => …, a, b)";
  }
  if ((op === "$eval" || op === "$$eval") && (typeof request["selector"] !== "string" || !request["selector"])) return `page.${op}() takes a CSS selector first`;
  return null;
}

export function evaluateExpression(request: PageRequest): string {
  if (request["isFunction"] !== true) return fnOf(request);
  return `(${fnOf(request)})(...${jsonArgs(request)})`;
}

export function selectorExpression(request: PageRequest): string {
  const selector = JSON.stringify(String(request["selector"]));
  const args = jsonArgs(request);
  if (request["op"] === "$$eval") {
    return `((elements, fn, args) => fn(elements, ...args))(Array.from(document.querySelectorAll(${selector})), (${fnOf(request)}), ${args})`;
  }
  const missing = JSON.stringify(`page.$eval: no element matches ${String(request["selector"])}`);
  return `((element, fn, args) => { if (element === null) throw new Error(${missing}); return fn(element, ...args); })(document.querySelector(${selector}), (${fnOf(request)}), ${args})`;
}

export function frameFunction(request: PageRequest): [string, unknown[]] {
  const op = request["op"];
  const args = argsOf(request);
  if (op === "evaluate") {
    if (request["isFunction"] !== true) return ["function (source) { return (0, eval)(source); }", [fnOf(request)]];
    return [`function (...args) { return (${fnOf(request)})(...args); }`, args];
  }
  const selector = String(request["selector"]);
  if (op === "$$eval") return [`function (selector, ...args) { return (${fnOf(request)})(Array.from(document.querySelectorAll(selector)), ...args); }`, [selector, ...args]];
  return [
    `function (selector, ...args) { const element = document.querySelector(selector); if (element === null) throw new Error("page.$eval: no element matches " + selector); return (${fnOf(request)})(element, ...args); }`,
    [selector, ...args],
  ];
}

export async function framesAnswer(page: Page): Promise<{ frames: Record<string, unknown>[] }> {
  await page.refreshFrames();
  const frames = [...page.frames.values()].map((frame) => ({
    id: frame.id,
    url: frame.url,
    name: frame.name,
    origin: frame.origin,
    parent: frame.parent,
    main: frame.id === page.mainFrame,
    crossProcess: page.frameSessions.has(frame.id),
  }));
  return { frames };
}
