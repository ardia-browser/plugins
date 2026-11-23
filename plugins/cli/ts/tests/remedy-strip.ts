type Span = { start: number; end: number; row: number | null };

const REMEDY_KEY = ',"remedy":';

function failed(value: unknown, isRow: boolean): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const failure = row["success"] === false || (isRow && row["ok"] === false);
  return failure && typeof row["remedy"] === "string";
}

function stringEnd(text: string, quote: number): number {
  for (let index = quote + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === '"') return index + 1;
  }
  return -1;
}

function remedySpans(text: string): Span[] {
  const spans: Span[] = [];
  const top = text[0];
  const ownDepth = top === "{" ? 1 : 2;
  let depth = 0;
  let row = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '"') {
      const end = stringEnd(text, index);
      if (end < 0) return [];
      index = end - 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "," && top === "[" && depth === 1) {
      row += 1;
      continue;
    }
    if (char !== "," || depth !== ownDepth || !text.startsWith(REMEDY_KEY, index)) continue;
    const quote = index + REMEDY_KEY.length;
    if (text[quote] !== '"') continue;
    const end = stringEnd(text, quote);
    if (end < 0) return [];
    spans.push({ start: index, end, row: top === "[" ? row : null });
  }
  return spans;
}

export function stripEnvelopeRemedyLine(line: string): string {
  if (!line.includes(REMEDY_KEY) || (line[0] !== "{" && line[0] !== "[")) return line;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return line;
  }
  const owners = Array.isArray(value) ? value : [value];
  let out = line;
  for (const span of remedySpans(line).reverse()) {
    const owner = span.row === null ? owners[0] : owners[span.row];
    if (failed(owner, span.row !== null)) out = out.slice(0, span.start) + out.slice(span.end);
  }
  return out;
}

export function stripEnvelopeRemedies(text: string): string {
  return text.split("\n").map(stripEnvelopeRemedyLine).join("\n");
}
