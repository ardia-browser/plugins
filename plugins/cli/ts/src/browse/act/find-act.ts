import { attach, observe } from "../changes/observe.ts";
import { checkedResult, filledResult, selectIn, typedResult } from "../commands/act.ts";
import type { Ctx } from "../commands/ctx.ts";
import { Result } from "../daemon/render.ts";
import { inputOf } from "../input/input.ts";
import type { Element, Page } from "../state/page.ts";
import { expectInput } from "./common.ts";
import { fill, setChecked, typeText } from "./fields.ts";
import { click, hover } from "./pointer.ts";

export async function findAct(ctx: Ctx, page: Page, element: Element, ref: string, action: string, rest: string[], humanize: boolean): Promise<Result> {
  const label = `@${ref}`;
  if (action === "click") {
    const [, report] = await observe(ctx, page, () => click(page, element, humanize));
    return attach(new Result({ clicked: label }), report);
  }
  if (action === "dblclick") {
    const [, report] = await observe(ctx, page, () => click(page, element, humanize, 2));
    return attach(new Result({ clicked: label, count: 2 }), report);
  }
  if (action === "fill") {
    const text = rest.slice(1).join(" ");
    const [[retargeted, stored, readback], report] = await observe(ctx, page, () => fill(page, element, text, humanize), [element, null]);
    return attach(filledResult("filled", label, retargeted, text, stored, readback ?? null), report);
  }
  if (action === "type") {
    const [retargeted, report] = await observe(ctx, page, () => typeText(page, element, rest.slice(1).join(" "), humanize), [element, null]);
    return attach(typedResult("typed", label, retargeted), report);
  }
  if (action === "check" || action === "uncheck") {
    const [changed, report] = await observe(ctx, page, () => setChecked(page, element, action === "check", humanize));
    return attach(checkedResult(action === "check", label, changed), report);
  }
  if (action === "select") return selectIn(ctx, page, element, label, rest.slice(1), humanize);
  if (action === "hover") {
    const [, report] = await observe(ctx, page, () => hover(page, element, humanize));
    return attach(new Result({ hovered: label }), report);
  }
  if (action === "focus") {
    const [, report] = await observe(ctx, page, () => page.focusElement(element));
    return attach(new Result({ focused: label }), report);
  }
  const key = rest.length > 1 ? (rest[1] as string) : "Enter";
  const frame = element.frame || page.mainFrame;
  const input = inputOf(page);
  const focusAndPress = async () => {
    await page.focusElement(element);
    return input.gesture("press", () => input.pressCombo(key, humanize));
  };
  const [, report] = await observe(ctx, page, () => expectInput(page, frame, focusAndPress, { keydown: 1 }, "The key press"), [element, null]);
  return attach(new Result({ pressed: key, in: label }), report);
}
