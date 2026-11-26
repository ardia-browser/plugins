import { describe, expect, test } from "bun:test";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import { begin } from "../src/browse/metrics.ts";
import { extractFilled } from "../src/browse/read/pages.ts";
import type { Page } from "../src/browse/state/page.ts";

const FULL_SECOND = { title: "Second", url: "http://s/second", text: "the second document ".repeat(20), matched: 1, status: 200 };
const FULL_FIRST = { title: "First", url: "http://s/first", text: "the first document ".repeat(20), matched: 1, status: 200 };
const THIN_FIRST = { title: "First", url: "http://s/first", text: "short", matched: 1, status: 200 };

type Step = { flip?: boolean; throw?: boolean; result?: Record<string, unknown> };

class RedirectingPage {
  url = "http://s/first";
  mainFrame = "F";
  networkOn = false;
  network = { fetchesStarted: new Map<string, number>(), fetchesBusyUntil: 0 };
  extracts = 0;

  constructor(readonly steps: Step[]) {}

  async call(fn: string, args: unknown[]): Promise<unknown> {
    if (Array.isArray(args) && args.length === 0) return ["complete", "7:7", false];
    this.extracts += 1;
    const fallback: Step = { result: FULL_SECOND };
    const step = this.steps.at(this.extracts - 1) ?? fallback;
    if (step.flip) this.url = "http://s/second";
    if (step.throw) throw new BrowseError("the page navigated while reading it; try again", null, "page_navigated");
    return { ...(step.result ?? FULL_SECOND) };
  }
}

async function read(steps: Step[], timeout: number): Promise<{ got: Record<string, unknown>; page: RedirectingPage; reread: unknown }> {
  const page = new RedirectingPage(steps);
  let reread: unknown;
  const got = await begin({ argv: ["read"] }, async (m) => {
    const result = await extractFilled(page as unknown as Page, null, timeout);
    reread = m.values.get("read_reread_after_navigation");
    return result;
  });
  return { got, page, reread };
}

describe("a read that navigates mid-read is read again", () => {
  test("a redirect that eats the poll deadline is re-extracted after settling", async () => {
    const { got, reread } = await read([{ result: THIN_FIRST }, { flip: true, throw: true }], 1.2);
    expect(got["title"]).toBe("Second");
    expect(String(got["text"])).toContain("the second document");
    expect(got["url"]).toBe("http://s/second");
    expect(reread).toBe(true);
  });

  test("a quiet commit after the last extraction is re-extracted on the URL mismatch", async () => {
    const { got, reread } = await read([{ result: THIN_FIRST }, { flip: true, result: FULL_FIRST }], 4);
    expect(got["title"]).toBe("Second");
    expect(got["url"]).toBe("http://s/second");
    expect(reread).toBe(true);
  });

  test("a page_navigated recovered inside the polling loop counts the reread too", async () => {
    const { got, reread } = await read([{ result: THIN_FIRST }, { flip: true, throw: true }], 4);
    expect(got["title"]).toBe("Second");
    expect(reread).toBe(true);
  });

  test("a still-thin destination keeps the remaining polling budget", async () => {
    const thinSecond = { ...FULL_SECOND, text: "Loading…" };
    const { got, page } = await read([{ result: THIN_FIRST }, { flip: true, result: FULL_FIRST }, { result: thinSecond }, { result: FULL_SECOND }], 4.5);
    expect(got["title"]).toBe("Second");
    expect(String(got["text"])).toContain("the second document");
    expect(page.extracts).toBe(4);
  });

  test("a plain read sets no reread flag", async () => {
    const { got, reread, page } = await read([{ result: FULL_FIRST }], 4);
    expect(got["title"]).toBe("First");
    expect(page.extracts).toBe(1);
    expect(reread).toBeUndefined();
  });
});
