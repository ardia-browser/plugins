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

const PIECES = ["token=", "page_token=", '"', "\\", "\\\"", "a", "Z9", "&", "=", " ", "\n", "\t", "<", ">", "'", "é", "\u2028", "\u0001", "/", "%22", "\\u0022"];

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
      expect(parsed.exit as unknown).toBe("***");
      expect(parsed.items as unknown).toEqual(["***", 2, "***"]);
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
      expect(parsed.n as unknown).toBe("***");
      expect(stillJson(parsed.deeper)).toEqual({ tok: "***", count: "***" });
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
    expect(stillJson(first as string)).toEqual({ n: "***", s: "***" });
    expect(plain).toBe("plain *** ***");
    expect(stillJson(last as string)).toEqual(["***"]);
  });

  test("the module-wide secrets mask JSON the same way", () => {
    clearSecrets();
    try {
      addSecret("1");
      addSecret("abc\"def");
      expect(stillJson(redact(JSON.stringify({ exit: 2, s: 'x abc"def' })))).toEqual({ exit: 2, s: "x ***" });
      expect(stillJson(redact(JSON.stringify({ exit: 1 })))).toEqual({ exit: "***" });
    } finally {
      clearSecrets();
    }
  });

  test("no secret survives that the plain replacement would have masked (Codex r1 on #79)", () => {
    const held = new Secrets();
    held.add("[123456789]");
    expect(held.redact(JSON.stringify({ s: "[123456789]" }))).toBe('{"s":"***"}');
    const spanning = new Secrets();
    spanning.add("12345,67890");
    const masked = spanning.redact(JSON.stringify({ s: "[12345,67890]" }));
    expect(masked.includes("12345,67890")).toBe(false);
    stillJson(masked);
    const top = new Secrets();
    top.add("12345,67890");
    expect(top.redact("[12345,67890]").includes("12345,67890")).toBe(false);
    const lines = new Secrets();
    lines.add("alpha\nbeta");
    for (const text of ['prefix alpha\nbeta suffix\n{"s":"ok"}\n', 'prefix alpha\r\nbeta\n{"s":"ok"}\n'.replace("alpha\r\nbeta", "alpha\nbeta"), '{"s":"ok"}\nalpha\nbeta\n']) {
      expect(lines.redact(text).includes("alpha\nbeta")).toBe(false);
    }
    const crlf = new Secrets();
    crlf.add("alpha\r\nbeta");
    expect(crlf.redact('x alpha\r\nbeta y\r\n{"s":"ok"}\r\n').includes("alpha\r\nbeta")).toBe(false);
  });

  test("keywords never take a mask, and deep nesting keeps every level JSON", () => {
    const held = new Secrets();
    held.add("r");
    held.add("123456789");
    expect(stillJson(held.redact(JSON.stringify({ ok: true, no: false, none: null, s: "rr" })))).toEqual({ ok: true, no: false, none: null, s: "******" });
    let text = JSON.stringify({ n: 123456789 });
    for (let level = 0; level < 12; level += 1) text = JSON.stringify({ s: text });
    let value: unknown = stillJson(held.redact(text));
    for (let level = 0; level < 12; level += 1) value = stillJson((value as { s: string }).s);
    expect(value).toEqual({ n: "***" });
  });

  test("a re-encoded string never turns an escaped bidi or separator character literal", () => {
    const held = new Secrets();
    held.add("secret");
    const text = JSON.stringify({ body: JSON.stringify({ a: "é \u202e \u2028 \u0085", b: "secret" }) }).replaceAll("\u202e", "\\u202e").replaceAll("\u2028", "\\u2028");
    expect(/[\u202e\u2028]/u.test(text)).toBe(false);
    const masked = held.redact(text);
    expect(/[\u202e\u2028\u0085]/u.test(masked)).toBe(false);
    expect(stillJson((stillJson(masked) as { body: string }).body)).toEqual({ a: "é \u202e \u2028 \u0085", b: "***" });
  });

  test("masking is linear: 200,000 repeats of a one-letter secret take well under a second", () => {
    const held = new Secrets();
    held.add("a");
    held.add("aa");
    const text = JSON.stringify({ s: "a".repeat(200_000) });
    const started = performance.now();
    const masked = held.redact(text);
    expect(performance.now() - started).toBeLessThan(1000);
    expect((stillJson(masked) as { s: string }).s).toBe("***".repeat(100_000));
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
        expect(parsed.n as unknown).toBe(String(value.n).includes("1") ? "***" : value.n);
        stillJson(parsed.nested);
        for (const secret of ["1", "café", 'abc"def']) expect(JSON.stringify(parsed).includes(secret) && !JSON.stringify(value).includes(secret)).toBe(false);
        expect(secrets.redact(masked)).toBe(masked);
      }
    }
  });
});

describe("JSON-aware masking round 2 (Codex r2 on #79)", () => {
  function masked(secrets: string[], text: string): string {
    const held = new Secrets();
    for (const secret of secrets) held.add(secret);
    return held.redact(text);
  }

  test("a secret spanning tokens masks the smallest enclosing value, keeping escape-aware masks", () => {
    const out = masked(["12345,67890", "café"], '[12345,67890,"caf\\u00e9"]');
    expect(JSON.parse(out)).toBe("***");
    expect(JSON.parse(masked(["12345,67890"], '{"keep":2,"x":[12345,67890]}'))).toEqual({ keep: 2, x: "***" });
    expect(JSON.parse(masked(['foo","bar'], '["foo","bar"]'))).toBe("***");
  });

  test("a whole credential inside an embedded document never survives", () => {
    for (const [secret, text] of [["[true]", '{"s":"[true]"}'], ['["private-key"]', JSON.stringify({ s: '["private-key"]' })], ["[123456789]", '{"s":"[123456789]"}']] as const) {
      const out = masked([secret], text);
      expect(out.includes(secret)).toBe(false);
      expect(JSON.parse(out)).toEqual({ s: "***" });
    }
  });

  test("serializers that escape / or < > & still get masked", () => {
    expect(JSON.parse(masked(["a/b<c>&d"], '{"s":"x a\\/b\\u003cc\\u003e\\u0026d y"}'))).toEqual({ s: "x *** y" });
  });

  test("multi-megabyte inputs stay fast with a known secret", () => {
    const array = JSON.stringify([...Array.from({ length: 400_000 }, () => "[not json"), "secret"]);
    const lines = `${Array.from({ length: 400_000 }, () => "[not json").join("\n")}\nsecret\n`;
    const overlap = JSON.stringify(`${"a".repeat(2 * 65_536 - 1)}b`);
    const started = performance.now();
    expect(masked(["secret"], array).endsWith('"***"]')).toBe(true);
    expect(masked(["secret"], lines).endsWith("\n***\n")).toBe(true);
    JSON.parse(masked([`${"a".repeat(65_536)}b`, "a".repeat(65_536)], overlap));
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("JSON-aware masking round 3 (Codex r3 on #79)", () => {
  function masked(secrets: string[], text: string): string {
    const held = new Secrets();
    for (const secret of secrets) held.add(secret);
    return held.redact(text);
  }

  test("bare top-level numbers and keywords stay JSON", () => {
    expect(JSON.parse(masked(["1"], "-0.5e+10"))).toBe("***");
    expect(masked(["false"], "false\r\n")).toBe("false\r\n");
  });

  test("a match that takes in a string's quote masks the string", () => {
    expect(JSON.parse(masked(['"foo'], '{"value":"foobar"}'))).toEqual({ value: "***" });
  });

  test("a secret spelled with \\u escapes is found at every level", () => {
    expect(JSON.parse(masked(["a"], '{"q":"\\u0061"}'))).toEqual({ q: "***" });
    const nested = JSON.parse(masked(["café"], JSON.stringify({ body: String.raw`{"q":"café"}` })));
    expect(JSON.parse(nested.body)).toEqual({ q: "***" });
  });

  test("masking one JSON line never joins it with the next", () => {
    const out = masked(["2"], '{"n":2} \r\n{"n":3}\r\n');
    expect(out.split("\r\n").filter((line) => line.trim()).map((line) => JSON.parse(line))).toEqual([{ n: "***" }, { n: 3 }]);
  });

  test("dense hits on one long plain line stay near the cost of the plain replace", () => {
    const text = `${"a".repeat(1 << 19)}\nother\n`;
    const started = performance.now();
    expect(masked(["a"], text).endsWith("\nother\n")).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("JSON-aware masking round 4 (Codex r4 on #79)", () => {
  function masked(secrets: string[], text: string): string {
    const held = new Secrets();
    for (const secret of secrets) held.add(secret);
    return held.redact(text);
  }

  test("a secret spanning a document's leading whitespace and its content masks the document", () => {
    const out = masked([' {"credential":7}'], ' {"credential":7}');
    expect(out).toBe(' "***"');
  });

  test("a secret across JSON lines masks just those lines and keeps the others' masks", () => {
    const out = masked(["}\n{", "sample-secret"], '{"a":1}\n{"b":2}\n {"v":"\\u0073ample-secret"}\n');
    const records = out.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    expect(records).toEqual(["***", "***", { v: "***" }]);
  });

  test("closing delimiters in deep nesting mask in linear time", () => {
    const deep = `${"[".repeat(40_000)}0${"]".repeat(40_000)}`;
    const started = performance.now();
    expect(masked(["]"], deep)).toBe('"***"');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("JSON-aware masking round 5 (Codex r5 on #79)", () => {
  function masked(secrets: string[], text: string): string {
    const held = new Secrets();
    for (const secret of secrets) held.add(secret);
    return held.redact(text);
  }

  test("a plain-text secret ending in a line break leaves the next JSON record whole", () => {
    expect(masked(["session-note\n"], 'session-note\n{"k":1}\n')).toBe('***\n{"k":1}\n');
  });

  test("a match on already-masked text doesn't stop a later secret being masked", () => {
    const out = masked(["\n***", "session-note\n123456789"], '"\\"***\\""\n***\nsession-note\n123456789\n');
    expect(out.includes("session-note\n123456789")).toBe(false);
    expect(out.includes("session-note")).toBe(false);
  });

  test("many cross-line matches mask in linear time", () => {
    const started = performance.now();
    const out = masked(["}\n{"], '{"n":1}\n'.repeat(32_000));
    expect(out.includes("}\n{")).toBe(false);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
