import { isSpace, strip } from "./py.ts";
import { pyRegex } from "./pyre.ts";
import { codePoints, isDecimal, joinCodePoints } from "./pystr.ts";
import decimals from "../../py-decimals.txt" with { type: "text" };

const QUOTED_VALUE = String.raw`r?"""[\s\S]*?(?:"""|\Z)|r?\'\'\'[\s\S]*?(?:\'\'\'|\Z)|\\"(?:[^\\]|\\(?!"))*(?:\\"|\Z)` +
  String.raw`|"(?:[^"\\]|\\[\s\S]?)*(?:"|\Z)|\'(?:[^\'\\]|\\[\s\S]?)*(?:\'|\Z)|` + "`[^`]*(?:`|\\Z)";
const AUTH_SCHEME = String.raw`(?:bearer|basic|token|negotiate|ntlm|hoba|mutual|aws4-hmac-sha256)`;
const CREDENTIAL = String.raw`(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-]|[A-Za-z]{20})[A-Za-z0-9._~+/=-]+`;
const SECRET_KEY =
  String.raw`[A-Za-z0-9_.-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key` +
  String.raw`|credentials?|session[_-]?(?:id|key|token|secret)|sessionid|auth[_-]?(?:token|key|code)|cookie|signature|otp)[A-Za-z0-9_-]*`;

const URL = pyRegex(String.raw`\b([a-zA-Z][a-zA-Z0-9+.-]{1,15}://)([^\s/?#<>"'` + "`" + String.raw`@]*@)?([^\s/?#<>"'` + "`" + String.raw`]*)([^\s?#<>"'` + "`" + String.raw`]*)([?#][^\s<>"'` + "`" + String.raw`]*)?`, "g");
const EMAIL = pyRegex(String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`, "g");
const PRIVATE_KEY_BLOCK = pyRegex(String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)`, "g");
const KNOWN_SECRET = pyRegex(
  String.raw`(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{10,}` +
    String.raw`|[pr]k_(?:live|test)_[A-Za-z0-9]{10,}|xox[abposre]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}` +
    String.raw`|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|hf_[A-Za-z0-9]{30,}` +
    String.raw`|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})`,
  "g",
);
const DIGEST = pyRegex(String.raw`(?i)\bdigest(\s+)(?:[a-z][a-z0-9-]*\s*=\s*(?:` + QUOTED_VALUE + String.raw`|[^,\s]+)(?:\s*,\s*)?)+`, "g");
const HEADER = pyRegex(
  String.raw`(?i)(?<![A-Za-z0-9-])((?:proxy-)?authorization|(?:set-)?cookie|x-[a-z0-9-]*(?:token|key|secret|auth|session|password)[a-z0-9-]*` +
    String.raw`|api-key|private-token)(["'` + "`" + String.raw`]?\s*:[ \t]*)((?:` + AUTH_SCHEME + String.raw`[ \t]+)?(?:` + QUOTED_VALUE +
    String.raw`|(?:[^\r\n'"` + "`" + String.raw`]|"[^"\r\n]*")+))`,
  "g",
);
const SCHEME_VALUE = pyRegex(String.raw`(?i)(?<![A-Za-z0-9])(bearer|basic)([ \t]+)(` + QUOTED_VALUE + "|" + CREDENTIAL + ")", "g");
const KEY_VALUE = pyRegex(
  String.raw`(?i)(?<![A-Za-z0-9_.-])(\\?["'` + "`" + String.raw`]?` + SECRET_KEY + String.raw`\\?["'` + "`" + String.raw`]?\]?)(\s*(?:=>|:=|=|:)\s*)((?:` +
    AUTH_SCHEME + String.raw`\s+)?(?:` + QUOTED_VALUE + String.raw`|[^\s,;&'"` + "`" + String.raw`<>(){}\[\]]+))`,
  "g",
);
const SECRET_FLAG = pyRegex(String.raw`(?i)(?<![A-Za-z0-9_-])(--?` + SECRET_KEY + String.raw`)([ \t]+)(` + QUOTED_VALUE + String.raw`|[^\s'"` + "`" + "]+)", "g");
const USER_FLAG = pyRegex(String.raw`(?<!\S)(-u|--user|--proxy-user)([ \t]+|=)(` + QUOTED_VALUE + String.raw`|[^\s'"` + "`" + "]+)", "g");
const COOKIE_PAIR = pyRegex(
  String.raw`(?i)(?<![A-Za-z0-9_.-])((?:session|sess|sid|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|csrftoken|xsrf-token` +
    String.raw`|_[a-z0-9_]*session[a-z0-9_]*))(=)([^\s;,&'"` + "`" + "]+)",
  "g",
);
const REDACTED = "<redacted>";
const PLACEHOLDER_SOURCE = String.raw`<(?:redacted|secret|email|number|user)>`;
const PLACEHOLDER = pyRegex(PLACEHOLDER_SOURCE, "g");
const WHOLE_PLACEHOLDER = pyRegex(`^(?:${PLACEHOLDER_SOURCE})$`);
const LONG_TOKEN = pyRegex(
  String.raw`(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9_+/=-])`,
  "g",
);
const CARD_NUMBER = pyRegex(String.raw`(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])`, "g");
const HOME_PATH = pyRegex(String.raw`(/Users/|/home/)(?!<user>)[^/\s'"` + "`]+", "g");
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const SCRUB_WINDOW = 4;
const TRAILING_SPACE = pyRegex(String.raw`\s+\Z`);

const DECIMAL_STARTS: [number, number][] = decimals
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => {
    const [start = "", end = ""] = line.split(" ");
    return [Number.parseInt(start, 16), Number.parseInt(end, 16)];
  });

function digitValue(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  const range = DECIMAL_STARTS.find(([start, end]) => code >= start && code <= end);
  return range === undefined ? 0 : (code - range[0]) % 10;
}

function luhnValid(digits: string[]): boolean {
  let total = 0;
  digits
    .slice()
    .reverse()
    .forEach((ch, index) => {
      const value = digitValue(ch) * (index % 2 ? 2 : 1);
      total += value > 9 ? value - 9 : value;
    });
  return total % 10 === 0;
}

function scrubCard(match: string): string {
  return luhnValid(codePoints(match).filter(isDecimal)) ? "<number>" : match;
}

function keepName(_whole: string, name: string, between: string): string {
  return `${name}${between}${REDACTED}`;
}

function scrubUrl(_whole: string, scheme: string, _login: string | undefined, host: string, path: string, rest: string | undefined): string {
  return `${scheme}${host}${path}${rest ? `?${REDACTED}` : ""}`;
}

function rfindSpace(points: string[]): number {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const ch = points[index];
    if (ch === " " || ch === "\n" || ch === "\t") return index;
  }
  return -1;
}

export function wholeWords(text: string, limit: number): string {
  const points = codePoints(text);
  if (points.length <= limit) return text;
  const cut = points.slice(0, limit);
  const space = rfindSpace(cut);
  return space > 0 ? joinCodePoints(cut.slice(0, space)) : "";
}

export function scrub(input: string): string {
  let text = input.replace(CONTROL, " ");
  text = text.replace(PRIVATE_KEY_BLOCK, REDACTED);
  text = text.replace(DIGEST, (_whole, spaces: string) => `Digest${spaces}${REDACTED}`);
  text = text.replace(HEADER, keepName);
  text = text.replace(URL, scrubUrl);
  text = text.replace(KEY_VALUE, keepName);
  text = text.replace(SECRET_FLAG, keepName);
  text = text.replace(USER_FLAG, keepName);
  text = text.replace(COOKIE_PAIR, keepName);
  text = text.replace(SCHEME_VALUE, (whole: string, name: string, between: string, value: string) =>
    WHOLE_PLACEHOLDER.test(value) ? whole : keepName(whole, name, between),
  );
  text = text.replace(KNOWN_SECRET, "<secret>");
  text = text.replace(EMAIL, "<email>");
  text = text.replace(LONG_TOKEN, "<secret>");
  text = text.replace(CARD_NUMBER, scrubCard);
  text = text.replace(HOME_PATH, (_whole, prefix: string) => `${prefix}<user>`);
  return strip(text, isSpace);
}

export function onlyPlaceholders(text: string): boolean {
  return !LETTER_OR_DIGIT.test(text.replace(PLACEHOLDER, " "));
}

export function freeText(text: string, limit: number): [string, boolean] {
  const clipped = codePoints(text).length > limit * SCRUB_WINDOW;
  const scrubbed = scrub(wholeWords(text, limit * SCRUB_WINDOW));
  const points = codePoints(scrubbed);
  if (points.length <= limit) return [scrubbed, clipped];
  const kept = wholeWords(scrubbed, limit).replace(TRAILING_SPACE, "");
  return [kept || joinCodePoints(points.slice(0, limit)), true];
}
