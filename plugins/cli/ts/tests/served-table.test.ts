import assert from "node:assert/strict";
import { test } from "bun:test";
import { servedTable } from "../src/served.ts";

test("served.txt rows name one or two words, or a family, then the side", () => {
  const table = servedTable("--version rust\ntabs rust\n  skills   install ts \ncall * ts\nbad\ntabs rust extra\ntabs ts\n");
  assert.deepEqual([...table], [
    ["--version", "rust"],
    ["tabs", "rust"],
    ["skills install", "ts"],
    ["call *", "ts"],
  ]);
});
