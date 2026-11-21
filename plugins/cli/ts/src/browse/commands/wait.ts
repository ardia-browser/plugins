import { reprStr } from "../../py.ts";
import { dumps } from "../../json.ts";
import { evaluateMain } from "../act/react.ts";
import { evaluateIsolated } from "./pagejs.ts";
import { pyTruthy } from "../cdp/pyvalue.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { pyValue, Result } from "../daemon/render.ts";
import { MAX_GIVEN, plainNumber } from "../limits.ts";
import { parseRef } from "../state/refs.ts";
import type { Element, Page } from "../state/page.ts";
import { waitUntil } from "../state/wait.ts";
import { waitDownload } from "./act.ts";
import { globMatch, waitForLoad } from "./core.ts";
import { type Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { need, parse } from "./parse.ts";

export async function cmdWait(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(
    argv,
    { "--text": "value", "--url": "value", "--load": "value", "--fn": "value", "--state": "value", "--timeout": "value", "--download": "bool", "--isolated": "bool", "--main-world": "bool" },
    { "-t": "--text", "-u": "--url", "-l": "--load", "-f": "--fn" },
  );
  const timeout = options["timeout"] ? Number(options["timeout"]) / 1000 : ctx.timeout;
  const plain = Object.keys(options).length === 0 && args.length > 0 ? plainNumber(args[0] as string) : undefined;
  if ((options["timeout"] && timeout > MAX_GIVEN) || (plain !== undefined && plain / 1000 > MAX_GIVEN)) {
    throw new Usage(`waits are capped at one day (${Math.trunc(MAX_GIVEN * 1000)} ms); wait again for longer`);
  }
  if (options["download"]) {
    const path = args.length > 0 ? ctx.path(args[0] as string) : null;
    const saved = await waitDownload(ctx, null, path, timeout);
    return new Result({ path: saved, waited: "download" }, `✓ Downloaded to ${saved}`);
  }
  if (plain !== undefined) {
    await sleep(plain / 1000);
    return new Result({ ms: Math.trunc(plain), waited: "timeout" });
  }
  const page = await ctx.state.page();
  if (options["text"] !== undefined) {
    const wanted = options["text"] as string;
    await waitUntil(
      () => page.call("(t) => !!document.body && document.body.innerText.includes(t)", [wanted], { frame: page.mainFrame, read: true }),
      timeout,
      0.1,
      `text ${reprStr(wanted)}`,
    );
    return new Result({ text: wanted, waited: "text" }, wanted);
  }
  if (options["url"] !== undefined) {
    const pattern = options["url"] as string;
    await waitUntil(
      async () => {
        await page.refreshFrames();
        return globMatch(pattern, page.url);
      },
      timeout,
      0.1,
      `the URL to match ${pattern}`,
    );
    return new Result({ url: page.url, waited: "url" }, page.url);
  }
  if (options["load"] !== undefined) {
    const until = options["load"] as string;
    if (!["load", "domcontentloaded", "networkidle"].includes(until)) throw new Usage("--load takes load, domcontentloaded or networkidle");
    await page.refreshFrames();
    await waitForLoad(page, page.loader(page.mainFrame), timeout, until);
    return new Result({ state: until });
  }
  if (options["fn"] !== undefined) {
    const expression = options["fn"] as string;
    const found = (await waitUntil(
      async () => {
        const value = options["isolated"] ? await evaluateIsolated(page, expression) : await evaluateMain(page, expression);
        return pyTruthy(value) ? { value } : null;
      },
      timeout,
      0.1,
      `${expression} to be truthy`,
    )) as { value: unknown };
    return new Result({ result: found.value }, dumps(pyValue(found.value), "indented"));
  }
  need(args, 1, "wait <selector|ms> | --text | --url | --load | --fn");
  const selector = args[0] as string;
  const wanted = (options["state"] as string | undefined) || "visible";
  await waitUntil(() => selectorState(ctx, page, selector, wanted), timeout, 0.1, `${selector} to be ${wanted}`);
  return new Result({ selector, waited: "selector" });
}

async function selectorState(ctx: Ctx, page: Page, selector: string, wanted: string): Promise<boolean> {
  const ref = parseRef(selector);
  let found: [Page, Element];
  try {
    found = ref ? await ctx.state.resolveRef(ref) : await ctx.state.locate(selector, page);
  } catch (error) {
    if (error instanceof BrowseError && (error.code === "not_found" || error.code === "stale_ref")) return wanted === "hidden" || wanted === "detached";
    throw error;
  }
  if (wanted === "attached") return true;
  if (wanted === "detached") return false;
  const [owner, element] = found;
  const visible = pyTruthy(await owner.call("(el) => ardiaBrowse.visible(el)", [element], { frame: element.frame }));
  return wanted === "visible" ? visible : !visible;
}

register("wait", cmdWait);
