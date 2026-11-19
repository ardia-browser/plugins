import { charCount } from "../py.ts";

const MASK = "***";
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const TOKEN_QUERY = new RegExp(`(token=)[^&${PY_SPACE}'"<>\\\\]+`, "g");

function quote(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.~-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export class Secrets {
  private readonly held: string[] = [];

  private remember(secret: string): void {
    if (!this.held.includes(secret)) this.held.push(secret);
  }

  known(): boolean {
    return this.held.length > 0;
  }

  add(secret: string): void {
    if (secret === "") return;
    this.remember(secret);
    this.remember(quote(secret));
  }

  redact(text: string): string {
    const ordered = [...this.held].sort((a, b) => charCount(b) - charCount(a));
    let out = text;
    for (const secret of ordered) out = out.replaceAll(secret, MASK);
    return out.replace(TOKEN_QUERY, `$1${MASK}`);
  }
}
