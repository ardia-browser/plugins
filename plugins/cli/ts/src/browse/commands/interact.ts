import { addSecret } from "../../redact.ts";
import { editCell, fill } from "../act/fields.ts";
import { attach, observe } from "../changes/observe.ts";
import { BrowseError, ConnectionLost, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { count, flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";
import type { Ctx } from "./ctx.ts";
import { scopeOf, WITHIN_FLAG } from "./find-act.ts";
import { register } from "./index.ts";
import { need, parse } from "./parse.ts";
import { filledResult, resolve } from "./act.ts";
import { otpFields, splitDigits } from "../auth/vault.ts";

export const OTP_BOXES = `(scope, length) => {
  const root = scope || document;
  const skipped = ["hidden", "checkbox", "radio", "submit", "button", "file", "image", "reset", "range", "color"];
  const usable = (el) => {
    if (el.disabled || el.readOnly || skipped.includes((el.type || "").toLowerCase())) return false;
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const inputs = Array.from(root.querySelectorAll("input")).filter(usable);
  const boxes = inputs.filter((el) => el.maxLength === 1);
  const groups = new Map();
  for (const box of boxes) {
    let home = box.parentElement;
    for (let up = 0; home && up < 4; up += 1, home = home.parentElement) {
      if (Array.from(home.querySelectorAll("input")).filter((el) => el.maxLength === 1 && usable(el)).length >= 4) break;
    }
    const key = home || box.parentElement;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(box);
  }
  const fits = [...groups.values()].filter((group) => group.length >= 4 && group.length <= 8 && group.length >= length);
  fits.sort((a, b) => Number(b.length === length) - Number(a.length === length));
  if (fits.length > 0) return fits[0].slice(0, length);
  const oneTime = inputs.find((el) => (el.getAttribute("autocomplete") || "").toLowerCase().includes("one-time-code"));
  if (oneTime) return [oneTime];
  const hint = /otp|one.?time|code|token|2fa|mfa|verif|passcode/i;
  const named = inputs.find((el) => el.maxLength !== 1 && (el.inputMode === "numeric" || el.type === "tel" || el.type === "number" || el.type === "text") &&
    hint.test([el.name, el.id, el.getAttribute("autocomplete"), el.placeholder, el.getAttribute("aria-label"), el.closest("[class]") ? el.closest("[class]").className : ""].join(" ")));
  return named ? [named] : [];
}`;

export const OTP_SHAPE = /^[A-Za-z0-9]{4,8}$/u;

export function otpCode(given: string): string {
  const code = given.replace(/[\s-]+/gu, "");
  if (!OTP_SHAPE.test(code)) throw new Usage("fill-otp takes a one-time code of 4 to 8 letters or digits");
  return code;
}

async function cmdFillOtp(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--sensitive": "bool", "--no-humanize": "bool", ...WITHIN_FLAG }, {}, () => true);
  need(args, 1, "fill-otp <code> [--within <container>] [--sensitive]");
  const code = otpCode(args.join(""));
  const sensitive = Boolean(options["sensitive"]);
  if (sensitive) addSecret(code);
  const within = options["within"] === undefined ? null : String(options["within"]);
  let page: Page;
  let frame: string;
  let scope: Element | null = null;
  if (within !== null) {
    const found = await scopeOf(ctx, within);
    page = found.page;
    scope = found.container;
    frame = found.container.frame;
  } else {
    page = await ctx.state.page();
    frame = (ctx.state.frameFor(page) || page.mainFrame) as string;
  }
  let boxes = scope === null ? await otpFields(page, frame, code.length) : [];
  if (boxes.length === 0) {
    const remote = await page.call(OTP_BOXES, [scope, code.length], { frame, byValue: false, read: true });
    boxes = await page.elementsFrom(remote, frame, "one-time code box", 8);
  }
  if (boxes.length === 0) {
    throw new BrowseError(
      `No one-time code field found${within ? ` inside --within "${within}"` : ""}: no group of 4 to 8 single-character boxes, and no input marked autocomplete="one-time-code". Snapshot to find the field and use \`fill\``,
      { within },
      "not_found",
    );
  }
  const humanize = ctx.humanize && !options["no_humanize"];
  const split = boxes.length > 1;
  const parts = splitDigits(code, boxes.length);
  const [, report] = await observe(ctx, page, async () => {
    if (!split) {
      await fill(page, boxes[0] as Element, code, humanize);
      return;
    }
    for (let index = 0; index < parts.length; index += 1) await fill(page, boxes[index] as Element, parts[index] as string, humanize);
  });
  flag("fill_otp", true);
  count("fill_otp_boxes", boxes.length);
  const shape = split ? `${boxes.length} boxes` : "one field";
  return attach(new Result({ filled: true, boxes: boxes.length, length: code.length, sensitive }, `✓ Filled a ${code.length}-character one-time code into ${shape}`), report);
}

async function cmdEditCell(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--commit": "value", "--no-humanize": "bool", ...WITHIN_FLAG }, {}, (positionals) => positionals.length === 1);
  need(args, 2, "edit-cell <cell> <value> [--commit enter|tab] [--within <container>]");
  const commit = String(options["commit"] ?? "enter").toLowerCase();
  if (commit !== "enter" && commit !== "tab") throw new Usage("--commit takes enter or tab");
  const selector = args[0] as string;
  const text = args.slice(1).join(" ");
  const within = options["within"] === undefined ? null : String(options["within"]);
  const [page, element] = await resolve(ctx, selector, false, within);
  const humanize = ctx.humanize && !options["no_humanize"];
  const [stored, report] = await observe(ctx, page, () => editCell(page, element, text, humanize, commit === "tab" ? "Tab" : "Enter"), [element, null]);
  flag("edit_cell", true);
  return attach(filledResult("edited", selector, false, text, stored), report);
}

register("fill-otp", cmdFillOtp);
register("edit-cell", cmdEditCell);
