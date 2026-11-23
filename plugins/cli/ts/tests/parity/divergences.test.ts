import { expect, test } from "bun:test";
import { designed, designedText, withoutRemedies } from "./divergences.ts";
import type { Comparable } from "./compare.ts";

const empty = (): Comparable =>
  ({
    status: 0,
    stdout: { bytes: Buffer.from("") },
    stderr: { bytes: Buffer.from("") },
    requests: [],
    daemon_requests: [],
    telemetry: [],
    queued: [],
    usage: null,
    flush: null,
    files: new Map(),
    helpers: [],
    timed_out: false,
  }) as unknown as Comparable;

test("a remedy is dropped only from a failure envelope, never from a command's own payload", () => {
  expect(withoutRemedies('{"success":false,"data":null,"error":"x","code":"stale_ref","remedy":"ardia browse snapshot -i"}')).toBe('{"success":false,"data":null,"error":"x","code":"stale_ref"}');
  const payload = '{"success":true,"data":{"remedy":"ardia browse snapshot -i","code":"stale_ref"},"error":null}';
  expect(withoutRemedies(payload)).toBe(payload);
  const nested = '{"success":false,"data":{"code":"x","remedy":"ardia nope"},"error":"y"}';
  expect(withoutRemedies(nested)).toBe(nested);
  const rows = '[{"command":["click"],"success":false,"result":null,"error":"e","code":"stale_ref","remedy":"ardia browse snapshot -i"},{"command":["read"],"success":true,"result":{"remedy":"ardia keep"},"error":null}]';
  expect(withoutRemedies(rows)).toBe('[{"command":["click"],"success":false,"result":null,"error":"e","code":"stale_ref"},{"command":["read"],"success":true,"result":{"remedy":"ardia keep"},"error":null}]');
  expect(designedText("✗ gone (stale_ref)\n  remedy: ardia browse snapshot -i\n").text).toBe("✗ gone\n");
  expect(designedText("✗ odd (Bad Code)\n").text).toBe("✗ odd (Bad Code)\n");
});

test("only the shipped skill folders' commands.md is set aside; any other file by that name is compared", () => {
  const fresh = empty();
  const body = { bytes: Buffer.from("x") };
  fresh.files.set("outside/proj/.claude/skills/ardia/references/commands.md", ["written", "file", 420, body]);
  fresh.files.set("outside/notes/references/commands.md", ["written", "file", 420, body]);
  fresh.files.set("outside/proj/.claude/skills/other/references/commands.md", ["written", "file", 420, body]);
  expect([...designed(fresh).files.keys()]).toEqual(["outside/notes/references/commands.md", "outside/proj/.claude/skills/other/references/commands.md"]);
});

test("a remedy inside a successful payload or a successful batch row is never dropped", () => {
  const success = '{"success":true,"data":[{"success":false,"remedy":"ardia browse snapshot -i"}],"error":null}';
  expect(withoutRemedies(success)).toBe(success);
  const okRow = '[{"command":["read"],"success":true,"result":null,"error":null,"remedy":"ardia keep"},{"command":["click"],"success":false,"result":null,"error":"e","code":"stale_ref","remedy":"ardia browse snapshot -i"}]';
  expect(withoutRemedies(okRow)).toBe('[{"command":["read"],"success":true,"result":null,"error":null,"remedy":"ardia keep"},{"command":["click"],"success":false,"result":null,"error":"e","code":"stale_ref"}]');
});
