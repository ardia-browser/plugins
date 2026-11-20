import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Result } from "../../src/browse/daemon/render.ts";
import { render } from "../../src/browse/daemon/render.ts";
import { redact } from "../../src/redact.ts";

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
