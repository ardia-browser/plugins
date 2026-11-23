import { expect, test } from "bun:test";
import type { Entry } from "./canon.ts";
import { type Elastic, ReplayConn } from "./replay.ts";

const ELASTIC: Elastic = { lookahead: 1, repeats: () => false };
const REQUEST = JSON.stringify({ id: 1, method: "Browser.getVersion", params: {} });
const ANSWER = JSON.stringify({ id: 1, result: { product: "Chrome" } });

function replayed(closes: Entry[]): Promise<{ sent: string[]; closed: number[]; failed: string[] }> {
  const entries: Entry[] = [{ k: "out", c: 0, t: 0, m: REQUEST }, { k: "in", c: 0, t: 1, m: ANSWER }, ...closes];
  const sent: string[] = [];
  const closed: number[] = [];
  const failed: string[] = [];
  const conn = new ReplayConn(
    entries,
    {
      batch: (work) => work(),
      send: (text) => sent.push(text),
      close: (code) => closed.push(code),
      fail: (report) => failed.push(report),
      note: () => {},
    },
    ELASTIC,
    undefined,
    undefined,
  );
  conn.start();
  conn.request(REQUEST);
  return new Promise((resolve) => setTimeout(() => resolve({ sent, closed, failed }), 300));
}

test("the browser's answer to a close the daemon started is left to the live daemon's own close", async () => {
  const outcome = await replayed([{ k: "close", c: 0, t: 2, by: "daemon", code: 1000 }, { k: "close", c: 0, t: 3, by: "browser", code: 1000 }]);
  expect(outcome.failed).toEqual([]);
  expect(outcome.sent).toEqual([ANSWER]);
  expect(outcome.closed).toEqual([]);
});

test("a close the browser started is still played back", async () => {
  const outcome = await replayed([{ k: "close", c: 0, t: 2, by: "browser", code: 1006 }]);
  expect(outcome.failed).toEqual([]);
  expect(outcome.sent).toEqual([ANSWER]);
  expect(outcome.closed).toEqual([1006]);
});
