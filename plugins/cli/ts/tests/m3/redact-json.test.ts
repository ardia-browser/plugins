import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Result } from "../../src/browse/daemon/render.ts";
import { render } from "../../src/browse/daemon/render.ts";
import { addSecret, clearSecrets, redact, Secrets } from "../../src/redact.ts";

const PYTHON = process.env["ARDIA_TEST_PYTHON"] ?? "python3";
const FIXED_PATTERN = String.raw`(token=)[^&\s'"<>\\]+`;

describe("test_browse_review.TokenNeverPrinted (plugins#3)", () => {
  test("test_json_output_stays_valid_when_a_masked_value_ends_at_an_escaped_quote", () => {
    const data = { html: '<a href="/n?page_token=abc123">next</a>', note: 'x token=abc123" y' };
    const [, out] = render({ json: true }, new Result(data, ""));
    expect(JSON.parse(out).data).toEqual({ html: '<a href="/n?page_token=***">next</a>', note: 'x token=***" y' });
  });

  test("test_script_text_output_stays_valid_json_when_a_masked_value_ends_at_an_escaped_quote", () => {
    const data = { html: '<a href="/n?page_token=abc123">next</a>' };
    const [, out] = render({}, new Result(data, JSON.stringify(data, null, 2)));
    expect(JSON.parse(out)).toEqual({ html: '<a href="/n?page_token=***">next</a>' });
  });

  test("test_redact_keeps_json_escapes_whole_and_gives_the_same_text_when_repeated", () => {
    for (const value of ['x token=abc" y', "a\ntoken=abc\nb", 'token=abc"', 'token=abc\\"']) {
      const once = redact(JSON.stringify({ a: value }));
      expect(redact(once)).toBe(once);
      expect(JSON.parse(once).a).toBe(value.replace("abc", "***"));
    }
  });
});

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return state / 0x100000000;
  };
}

const PIECES = ["token=", "page_token=", '"', "\\", "\\\"", "a", "Z9", "&", "=", " ", "\n", "\t", "<", ">", "'", "é", " ", "\u0001", "/", "%22", "\\u0022"];

function sample(random: () => number): string {
  let text = "";
  const length = 1 + Math.floor(random() * 14);
  for (let index = 0; index < length; index += 1) text += PIECES[Math.floor(random() * PIECES.length)];
  return text;
}

describe("masking finished JSON keeps it JSON", () => {
  test("5,000 random values with tokens, quotes and backslashes serialize, mask and parse back", () => {
    const random = seeded(2026);
    for (let index = 0; index < 5000; index += 1) {
      const value = sample(random);
      for (const text of [JSON.stringify({ k: value }), JSON.stringify([value, { [value]: value }], null, 2)]) {
        const masked = redact(text);
        let parsed: unknown;
        try {
          parsed = JSON.parse(masked);
        } catch {
          throw new Error(`invalid JSON after masking ${JSON.stringify(text)}: ${masked}`);
        }
        expect(parsed).toBeDefined();
        expect(redact(masked)).toBe(masked);
      }
    }
  });

  test("the mask matches plugins#3's fixed Python pattern exactly", () => {
    const random = seeded(7);
    const texts = Array.from({ length: 400 }, () => JSON.stringify({ k: sample(random) }));
    const code = "import json, re, sys\npattern = re.compile(sys.argv[1])\nprint(json.dumps([pattern.sub(lambda m: m.group(1) + '***', t) for t in json.load(sys.stdin)]))";
    const done = spawnSync(PYTHON, ["-I", "-c", code, FIXED_PATTERN], { input: JSON.stringify(texts), encoding: "utf8" });
    expect(done.stderr).toBe("");
    expect(texts.map((text) => redact(text))).toEqual(JSON.parse(done.stdout));
  });
});

function asciiOnly(text: string): string {
  return text.replaceAll(/[\u0080-￿]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function stillJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON after masking: ${text}`);
  }
}

describe("masking known secrets keeps JSON whole (plugins#72)", () => {
  const secrets = new Secrets();
  for (const secret of ["1", "f", "u00", "abc\"def", "café", "tok\\en"]) secrets.add(secret);

  test("a secret that is a number, an escape letter or part of an escape never breaks the JSON around it", () => {
    const value = { exit: 1, text: "line\nbreak\fform é", items: [1, 2, 10], ok: true };
    for (const text of [JSON.stringify(value), JSON.stringify(value, null, 2), asciiOnly(JSON.stringify(value))]) {
      const parsed = stillJson(secrets.redact(text)) as typeof value;
      expect(parsed.exit).toBe(1);
      expect(parsed.items).toEqual([1, 2, 10]);
      expect(parsed.ok).toBe(true);
      expect(parsed.text).toBe("line\nbreak\f***orm é");
    }
  });

  test("a secret holding a quote, a backslash or a character the JSON escapes is masked, not left behind its escapes", () => {
    const value = { a: 'say abc"def', b: "x tok\\en y", c: "café crème" };
    for (const text of [JSON.stringify(value), asciiOnly(JSON.stringify(value))]) {
      const parsed = stillJson(secrets.redact(text)) as Record<string, string>;
      expect(parsed).toEqual({ a: "say ***", b: "x *** y", c: "*** crème" });
    }
  });

  test("JSON inside a JSON string is masked as JSON, so the inner document parses too", () => {
    const inner = JSON.stringify({ q: "café", n: 1, deeper: JSON.stringify({ tok: 'abc"def', count: 11 }) });
    for (const text of [JSON.stringify({ body: inner }), asciiOnly(JSON.stringify({ body: inner })), JSON.stringify([inner], null, 2)]) {
      const outer = stillJson(secrets.redact(text)) as { body?: string } | string[];
      const body = Array.isArray(outer) ? (outer[0] as string) : (outer.body as string);
      const parsed = stillJson(body) as { q: string; n: number; deeper: string };
      expect(parsed.q).toBe("***");
      expect(parsed.n).toBe(1);
      expect(stillJson(parsed.deeper)).toEqual({ tok: "***", count: 11 });
    }
  });

  test("an ASCII-only document stays ASCII-only after a nested mask", () => {
    const text = asciiOnly(JSON.stringify({ body: JSON.stringify({ q: "café", s: "naïve" }) }));
    const masked = secrets.redact(text);
    expect(/^[\x00-\x7f]*$/u.test(masked)).toBe(true);
    expect(stillJson((stillJson(masked) as { body: string }).body)).toEqual({ q: "***", s: "naïve" });
  });

  test("JSON lines mask line by line and plain text lines still mask by text", () => {
    const text = `${JSON.stringify({ n: 1, s: "café" })}\nplain café 1\n${JSON.stringify(["abc\"def"])}\n`;
    const [first, plain, last] = secrets.redact(text).split("\n");
    expect(stillJson(first as string)).toEqual({ n: 1, s: "***" });
    expect(plain).toBe("plain *** ***");
    expect(stillJson(last as string)).toEqual(["***"]);
  });

  test("the module-wide secrets mask JSON the same way", () => {
    clearSecrets();
    try {
      addSecret("1");
      addSecret("abc\"def");
      expect(stillJson(redact(JSON.stringify({ exit: 1, s: 'x abc"def' })))).toEqual({ exit: 1, s: "x ***" });
    } finally {
      clearSecrets();
    }
  });

  test("3,000 random documents with secrets, escapes and nesting mask to valid JSON", () => {
    const random = seeded(72);
    const pieces = [...PIECES, "1", "f", "\\f", "café", 'abc"def', "u00", "\\n", "😀"];
    const word = () => {
      let text = "";
      const length = 1 + Math.floor(random() * 10);
      for (let index = 0; index < length; index += 1) text += pieces[Math.floor(random() * pieces.length)];
      return text;
    };
    for (let index = 0; index < 3000; index += 1) {
      const value = { n: Math.floor(random() * 20), s: word(), nested: JSON.stringify({ t: word(), m: [word(), 1] }) };
      for (const text of [JSON.stringify(value), JSON.stringify(value, null, 2), asciiOnly(JSON.stringify(value))]) {
        const masked = secrets.redact(text);
        const parsed = stillJson(masked) as typeof value;
        expect(parsed.n).toBe(value.n);
        stillJson(parsed.nested);
        expect(secrets.redact(masked)).toBe(masked);
      }
    }
  });
});
