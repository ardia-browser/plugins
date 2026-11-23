import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { freeText, onlyPlaceholders, scrub } from "../src/scrub.ts";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";

const SEEDS = [
  "plain words here",
  "password=hunter2 and token: abc123def",
  "Authorization: Bearer abcdefghijklmnop.qrs",
  "authorization: Basic dXNlcjpwYXNz",
  "Cookie: session=abc; other=1",
  "x-api-token: 'quoted value' rest",
  "curl -u alice:secret https://user:pw@example.com/path?q=1#frag",
  "see http://host/a/b?c and ftp://x.y/z",
  "mail jane.doe+tag@example.co.uk now",
  "card 4111 1111 1111 1111 and 4111-1111-1111-1112",
  "card \u0664\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661 arabic",
  "/Users/jane/Library and /home/bob/x and /Users/<user>/y",
  "ghp_abcdefghijklmnopqrstuvwxyz0123 sk-abcdefghijklmnopqrst AKIAABCDEFGHIJKLMNOP",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "long token a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8 end",
  "Digest username=\"x\", realm=\"y\", nonce=abc",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
  "-----BEGIN PRIVATE KEY----- unterminated",
  "--password hunter2 --api-key=xyz -p",
  "session_id = 'abc' apiKey: \"def\" \\\"secret\\\": 1",
  "csrftoken=abcdef; PHPSESSID=123",
  "bearer <redacted> basic <secret>",
  "tabs\tand\nnewlines\u000b\u001c\u0085 mixed\u00a0spaces\u3000",
  "control\u0001chars\u007f here",
  "  leading and trailing  ",
  "<redacted> <email> <secret>",
  "_ _ <user>",
  "\u00e9moji 😀 and \u017fecret=abc and K=1",
  "\"\"\"triple password=\"\"\" 'single' `tick`",
  "a".repeat(300),
  "word ".repeat(120),
  "x\u2028y\u2029z",
];

function corpus(): string[] {
  const out = [...SEEDS];
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let index = 0; index < 400; index += 1) {
    const parts = Array.from({ length: 1 + Math.floor(random() * 4) }, () => SEEDS[Math.floor(random() * SEEDS.length)] as string);
    const glue = [" ", "\n", "", "=", ": ", "\t"][Math.floor(random() * 6)] as string;
    out.push(parts.join(glue));
  }
  return out;
}

test("scrub, free_text and only_placeholders match Python on a mixed corpus", () => {
  const texts = corpus();
  const limits = [10, 67, 200, 300];
  const script = `import json, sys
sys.path.insert(0, sys.argv[1])
from ardia_cli import telemetry_scrub as s
texts, limits = json.load(sys.stdin)
print(json.dumps([[s.scrub(t), s.only_placeholders(t), [list(s.free_text(t, n)) for n in limits]] for t in texts]))`;
  const done = spawnSync(PYTHON, ["-I", "-c", script, CLI], { input: JSON.stringify([texts, limits]), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(done.status, 0, done.stderr);
  const expected = JSON.parse(done.stdout) as [string, boolean, [string, boolean][]][];
  texts.forEach((text, index) => {
    const [scrubbed, placeholders, free] = expected[index] as [string, boolean, [string, boolean][]];
    assert.equal(scrub(text), scrubbed, `scrub ${JSON.stringify(text)}`);
    assert.equal(onlyPlaceholders(text), placeholders, `only_placeholders ${JSON.stringify(text)}`);
    limits.forEach((limit, at) => assert.deepEqual(freeText(text, limit), free[at], `free_text ${limit} ${JSON.stringify(text)}`));
  });
});
