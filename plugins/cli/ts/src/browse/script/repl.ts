export const REPL_CAPTURE = "__ardiaReplCapture__";
export const REPL_INIT = "__ardiaReplInit__";
const KEPT = "__ardiaKept__";
const MISS = "__ardiaMiss__";
const RESERVED = new Set([REPL_CAPTURE, REPL_INIT, KEPT, MISS, "__proto__", "arguments", "eval"]);
const PROTECTED_BUILTINS = new Set([
  "page", "browse", "read", "log", "sleep", "console", "state", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask",
  "URL", "URLSearchParams", "atob", "btoa", "structuredClone", "openTab", "listTabs", "useTab", "closeTab", "readUrls", "parseReceipt",
  "undefined", "NaN", "Infinity", "globalThis", "JSON", "Math", "Reflect", "Atomics", "Intl",
  "Object", "Function", "Boolean", "Symbol", "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "Number", "BigInt", "Date", "String", "RegExp", "Array", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent", "TextEncoder", "TextDecoder",
]);

type Token = { kind: "id" | "num" | "str" | "tpl" | "re" | "punct"; value: string; newline: boolean; start: number; end: number };

const NON_EXPR_STATEMENTS = new Set([
  "const", "let", "var", "function", "class", "return", "if", "for", "while", "do", "try", "switch", "throw", "break", "continue", "debugger", "with", "import", "export",
]);

const CONTINUATION_PUNCT = new Set([
  ".", "?.", "+", "-", "*", "/", "%", "**", "&&", "||", "??", "&", "|", "^", "==", "===", "!=", "!==", "<", "<=", ">", ">=", "<<", ">>", ">>>",
  "?", ":", ",", "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "&&=", "||=", "??=", "=>", "(", "[", ")", "]",
]);
const CONTINUATION_WORDS = new Set(["in", "instanceof"]);

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);
const STATEMENT_WORDS = new Set([
  "const", "let", "var", "function", "class", "return", "if", "for", "while", "do", "try", "switch", "throw", "break", "continue", "async",
]);
const IDENTIFIER_START = /[\p{L}\p{Nl}$_]/u;
const IDENTIFIER_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_‌‍]/u;
const PUNCTUATORS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "**", "++", "--", "+=", "-=", "*=", "%=", "&=", "|=", "^=", "<<", ">>"];

function endsExpression(token: Token | undefined): boolean {
  if (token === undefined) return false;
  if (token.kind === "num" || token.kind === "str" || token.kind === "tpl" || token.kind === "re") return true;
  if (token.kind === "id") return !KEYWORDS_BEFORE_EXPRESSION.has(token.value);
  return token.value === ")" || token.value === "]" || token.value === "}" || token.value === "++" || token.value === "--";
}

function skipTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") return index + 1;
    if (char === "$" && source[index + 1] === "{") {
      index = skipBraces(source, index + 2);
      continue;
    }
    index += 1;
  }
  return index;
}

function skipBraces(source: string, start: number): number {
  let depth = 1;
  let index = start;
  let previous: Token | undefined;
  while (index < source.length && depth > 0) {
    const [token, next] = readToken(source, index, previous);
    if (token === null) return next;
    if (token.kind === "punct" && token.value === "{") depth += 1;
    else if (token.kind === "punct" && token.value === "}") depth -= 1;
    previous = token;
    index = next;
  }
  return index;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\\") index += 2;
    else if (char === quote || char === "\n") return index + 1;
    else index += 1;
  }
  return index;
}

function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return index;
    if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") inClass = true;
    else if (char === "/") {
      index += 1;
      while (index < source.length && IDENTIFIER_PART.test(source[index] as string)) index += 1;
      return index;
    }
    index += 1;
  }
  return index;
}

function readToken(source: string, start: number, previous: Token | undefined): [Token | null, number] {
  let index = start;
  let newline = false;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "\n" || char === "\r" || char === " " || char === " ") {
      newline = true;
      index += 1;
    } else if (/\s/u.test(char)) index += 1;
    else if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      if (source.slice(index, stop).includes("\n")) newline = true;
      index = stop;
    } else break;
  }
  if (index >= source.length) return [null, index];
  const char = source[index] as string;
  if (char === '"' || char === "'") {
    const end = skipString(source, index);
    return [{ kind: "str", value: source.slice(index, end), newline, start: index, end }, end];
  }
  if (char === "`") {
    const end = skipTemplate(source, index);
    return [{ kind: "tpl", value: "`", newline, start: index, end }, end];
  }
  if (/[0-9]/u.test(char) || (char === "." && /[0-9]/u.test(source[index + 1] ?? ""))) {
    let end = index + 1;
    while (end < source.length && /[0-9A-Za-z_.]/u.test(source[end] as string)) end += 1;
    return [{ kind: "num", value: source.slice(index, end), newline, start: index, end }, end];
  }
  if (IDENTIFIER_START.test(char) || char === "\\" || char === "#") {
    let end = index + 1;
    while (end < source.length && IDENTIFIER_PART.test(source[end] as string)) end += 1;
    return [{ kind: "id", value: source.slice(index, end), newline, start: index, end }, end];
  }
  if (char === "/" && !(endsExpression(previous) && !(newline && previous?.kind === "punct" && previous.value === "}"))) {
    const end = skipRegex(source, index);
    return [{ kind: "re", value: source.slice(index, end), newline, start: index, end }, end];
  }
  for (const punct of PUNCTUATORS) {
    if (source.startsWith(punct, index)) return [{ kind: "punct", value: punct, newline, start: index, end: index + punct.length }, index + punct.length];
  }
  return [{ kind: "punct", value: char, newline, start: index, end: index + 1 }, index + 1];
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  for (;;) {
    const [token, next] = readToken(source, index, tokens[tokens.length - 1]);
    if (token === null) return tokens;
    tokens.push(token);
    index = next;
  }
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === "punct" && token.value === value;
}

function statementStart(tokens: readonly Token[], index: number): boolean {
  if (index === 0) return true;
  const previous = tokens[index - 1] as Token;
  if (isPunct(previous, ";") || isPunct(previous, "}")) return true;
  return (tokens[index] as Token).newline && endsExpression(previous);
}

function closing(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind !== "punct") continue;
    if (OPEN.has(token.value)) depth += 1;
    else if (CLOSE.has(token.value)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length;
}

function splitTopLevel(tokens: readonly Token[], from: number, to: number): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let index = from; index < to; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === "punct" && OPEN.has(token.value)) depth += 1;
    else if (token.kind === "punct" && CLOSE.has(token.value)) depth -= 1;
    else if (depth === 0 && isPunct(token, ",")) {
      parts.push([start, index]);
      start = index + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

function patternNames(tokens: readonly Token[], from: number, to: number, out: string[]): void {
  let start = from;
  if (start >= to) return;
  if (isPunct(tokens[start], "...")) start += 1;
  const first = tokens[start];
  if (first === undefined || start >= to) return;
  if (first.kind === "id") {
    out.push(first.value);
    return;
  }
  if (isPunct(first, "[")) {
    const end = Math.min(closing(tokens, start), to);
    for (const [a, b] of splitTopLevel(tokens, start + 1, end)) patternNames(tokens, a, defaultStart(tokens, a, b), out);
    return;
  }
  if (isPunct(first, "{")) {
    const end = Math.min(closing(tokens, start), to);
    for (const [a, b] of splitTopLevel(tokens, start + 1, end)) {
      if (a >= b) continue;
      if (isPunct(tokens[a], "...")) {
        patternNames(tokens, a, b, out);
        continue;
      }
      const colon = topLevelIndex(tokens, a, b, ":");
      if (colon >= 0) patternNames(tokens, colon + 1, defaultStart(tokens, colon + 1, b), out);
      else if ((tokens[a] as Token).kind === "id") out.push((tokens[a] as Token).value);
    }
  }
}

function topLevelIndex(tokens: readonly Token[], from: number, to: number, value: string): number {
  let depth = 0;
  for (let index = from; index < to; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === "punct" && OPEN.has(token.value)) depth += 1;
    else if (token.kind === "punct" && CLOSE.has(token.value)) depth -= 1;
    else if (depth === 0 && isPunct(token, value)) return index;
  }
  return -1;
}

function defaultStart(tokens: readonly Token[], from: number, to: number): number {
  const at = topLevelIndex(tokens, from, to, "=");
  return at < 0 ? to : at;
}

function declarationEnd(tokens: readonly Token[], from: number): number {
  let depth = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === "punct" && OPEN.has(token.value)) depth += 1;
    else if (token.kind === "punct" && CLOSE.has(token.value)) {
      if (depth === 0) return index;
      depth -= 1;
    } else if (depth === 0 && isPunct(token, ";")) return index;
    else if (depth === 0 && index > from && token.newline && endsExpression(tokens[index - 1])) {
      if (token.kind === "id" && STATEMENT_WORDS.has(token.value)) return index;
      if (token.kind === "id" || token.kind === "num" || token.kind === "str") {
        const before = tokens[index - 1] as Token;
        if (!(before.kind === "punct" && !CLOSE.has(before.value))) return index;
      }
    }
  }
  return tokens.length;
}

function declarators(tokens: readonly Token[], from: number, out: string[]): number {
  const end = declarationEnd(tokens, from);
  for (const [a, b] of splitTopLevel(tokens, from, end)) patternNames(tokens, a, defaultStart(tokens, a, b), out);
  return end;
}

export function declaredNames(source: string): string[] {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return [];
  }
  const names: string[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === "punct") {
      if (OPEN.has(token.value)) depth += 1;
      else if (CLOSE.has(token.value)) depth = Math.max(depth - 1, 0);
      continue;
    }
    if (depth !== 0 || token.kind !== "id" || !statementStart(tokens, index)) continue;
    const next = tokens[index + 1];
    if (token.value === "const" || token.value === "var" || (token.value === "let" && next !== undefined && (next.kind === "id" || isPunct(next, "[") || isPunct(next, "{")))) {
      index = declarators(tokens, index + 1, names) - 1;
      continue;
    }
    let at = index;
    if (token.value === "async" && next?.kind === "id" && next.value === "function" && !next.newline) at = index + 1;
    const word = tokens[at] as Token;
    if (word.value === "function") {
      let nameAt = at + 1;
      if (isPunct(tokens[nameAt], "*")) nameAt += 1;
      const name = tokens[nameAt];
      if (name?.kind === "id") names.push(name.value);
      index = nameAt;
    } else if (word.value === "class") {
      const name = tokens[at + 1];
      if (name?.kind === "id" && name.value !== "extends") names.push(name.value);
      index = at + 1;
    }
  }
  const valid = /^[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_‌‍]*$/u;
  return [...new Set(names)].filter((name) => valid.test(name) && !RESERVED.has(name));
}

function withImplicitReturn(source: string): string {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return source;
  }
  let lastEnd = tokens.length - 1;
  while (lastEnd >= 0 && isPunct(tokens[lastEnd], ";")) lastEnd -= 1;
  if (lastEnd < 0) return source;
  let depth = 0;
  let lastStart = -1;
  for (let index = 0; index <= lastEnd; index += 1) {
    const token = tokens[index] as Token;
    if (depth === 0 && !isPunct(token, ";") && statementStart(tokens, index)) {
      const explicitSep = index === 0 || isPunct(tokens[index - 1], ";") || isPunct(tokens[index - 1], "}");
      const continues =
        !explicitSep &&
        ((token.kind === "punct" && CONTINUATION_PUNCT.has(token.value)) ||
          (token.kind === "id" && CONTINUATION_WORDS.has(token.value)) ||
          token.kind === "tpl");
      const unaryOrOpen = token.kind === "punct" && (OPEN.has(token.value) || token.value === "!" || token.value === "~" || token.value === "+" || token.value === "-" || token.value === "++" || token.value === "--");
      if (!continues && (index === 0 || token.kind !== "punct" || unaryOrOpen)) {
        lastStart = index;
      }
    }
    if (token.kind === "punct") {
      if (OPEN.has(token.value)) depth += 1;
      else if (CLOSE.has(token.value)) depth = Math.max(depth - 1, 0);
    }
  }
  if (lastStart < 0) return source;
  const first = tokens[lastStart] as Token;
  const second = tokens[lastStart + 1];
  if (first.kind === "id") {
    if (NON_EXPR_STATEMENTS.has(first.value)) return source;
    if (first.value === "async" && second?.kind === "id" && second.value === "function" && !second.newline) return source;
    if (isPunct(second, ":")) return source;
  }
  if (isPunct(first, "{")) return source;
  const candidate = `${source.slice(0, first.start)}return ${source.slice(first.start)}`;
  try {
    new Function(`return async function () { ${candidate}\n}`);
    return candidate;
  } catch {
    return source;
  }
}

function hoistTopLevelBindings(source: string): string {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return source;
  }
  const edits: { start: number; end: number; text: string }[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === "punct") {
      if (OPEN.has(token.value)) depth += 1;
      else if (CLOSE.has(token.value)) depth = Math.max(depth - 1, 0);
      continue;
    }
    if (depth !== 0 || token.kind !== "id" || !statementStart(tokens, index)) continue;
    const next = tokens[index + 1];
    if (token.value === "const" || token.value === "var" || (token.value === "let" && next !== undefined && (next.kind === "id" || isPunct(next, "[") || isPunct(next, "{")))) {
      const end = declarationEnd(tokens, index + 1);
      if (end <= index + 1) continue;
      const declNames: string[] = [];
      const parts = splitTopLevel(tokens, index + 1, end);
      const exprs: string[] = [];
      let ok = true;
      for (const [a, b] of parts) {
        if (a >= b) {
          ok = false;
          break;
        }
        const eq = topLevelIndex(tokens, a, b, "=");
        const lhsEnd = eq < 0 ? b : eq;
        const partNames: string[] = [];
        patternNames(tokens, a, lhsEnd, partNames);
        if (partNames.length === 0) {
          ok = false;
          break;
        }
        declNames.push(...partNames);
        const startOff = (tokens[a] as Token).start;
        const endOff = (tokens[b - 1] as Token).end;
        const raw = source.slice(startOff, endOff);
        if (eq < 0) exprs.push(`${raw} = undefined`);
        else if (isPunct(tokens[a], "{")) exprs.push(`(${raw})`);
        else exprs.push(raw);
      }
      if (ok && declNames.length > 0 && !declNames.some((name) => RESERVED.has(name) || PROTECTED_BUILTINS.has(name))) {
        const endOff = (tokens[end - 1] as Token).end;
        const hasSemi = isPunct(tokens[end], ";");
        edits.push({
          start: token.start,
          end: endOff,
          text: `void (${REPL_INIT}(${JSON.stringify([...new Set(declNames)])}), ${exprs.join(", ")})${hasSemi ? "" : ";"}`,
        });
      }
      index = end - 1;
      continue;
    }
    if (token.value === "class" && next?.kind === "id" && next.value !== "extends") {
      if (RESERVED.has(next.value) || PROTECTED_BUILTINS.has(next.value)) continue;
      let brace = index + 2;
      while (brace < tokens.length && !isPunct(tokens[brace], "{")) brace += 1;
      if (brace < tokens.length) {
        const closeBrace = closing(tokens, brace);
        if (closeBrace < tokens.length) {
          const endOff = (tokens[closeBrace] as Token).end;
          const hasSemi = isPunct(tokens[closeBrace + 1], ";");
          edits.push({
            start: token.start,
            end: endOff,
            text: `void (${REPL_INIT}([${JSON.stringify(next.value)}]), ${next.value} = ${source.slice(token.start, endOff)})${hasSemi ? "" : ";"}`,
          });
          index = closeBrace;
        }
      }
    }
  }
  if (edits.length === 0) return source;
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += source.slice(cursor);
  try {
    new Function(`return async function () { ${out}\n}`);
    return out;
  } catch {
    return source;
  }
}

export function replSource(source: string, names: readonly string[] = declaredNames(source)): string {
  const body = hoistTopLevelBindings(withImplicitReturn(source));
  const kept = names.map((name) => `try { ${KEPT}[${JSON.stringify(name)}] = ${name}; } catch (${MISS}) {}`).join(" ");
  return `(async function () { ${REPL_CAPTURE}(function () { const ${KEPT} = Object.create(null); ${kept} return ${KEPT}; }); ${body}\n})`;
}
