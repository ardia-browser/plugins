import { afterEach, expect, spyOn, test } from "bun:test";
import * as pystr from "../src/pystr.ts";
import { outputChars } from "../src/browse/answer.ts";
import { Printer } from "../src/browse/output.ts";

const SAMPLES = ["", "plain", "é and ✓", "pair 😀 end", "lone \ud800 high", "lone \udc00 low", `split \ud800${pystr.SPLIT_TEXT}\udc00`, "\ud83d", "😀😀\ud800"];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const spies: { mockRestore(): void }[] = [];

test("codePointCount agrees with codePoints on every surrogate shape", () => {
  for (const sample of SAMPLES) expect(pystr.codePointCount(sample)).toBe(pystr.codePoints(sample).length);
});

test("output_chars and printing plain text build no code-point arrays", () => {
  const spy = spyOn(pystr, "codePoints");
  spies.push(spy);
  const big = "x".repeat(200_000) + "✓\n";
  expect(outputChars(new Map([["out", big], ["err", "é"]]))).toBe(BigInt(200_003));
  const printer = new Printer("strict");
  const write = spyOn(printer as unknown as { write(bytes: Uint8Array): void }, "write").mockImplementation(() => {});
  spies.push(write);
  printer.out(big);
  expect(write).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledTimes(0);
});

test("a starting daemon is looked for every 5 ms in its first second, then every 30 ms", async () => {
  const { pollDelay } = await import("../src/browse/spawn.ts");
  expect(pollDelay(0)).toBe(5);
  expect(pollDelay(999)).toBe(5);
  expect(pollDelay(1000)).toBe(30);
});
