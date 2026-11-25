import { sleep } from "../cdp/cancel.ts";
import type { Ctx } from "../commands/ctx.ts";
import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { count, flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";

export const REVEAL_POLLS_MS: readonly number[] = [100, 100, 100];
export const MAX_REVEALED = 12;
export const OVERLAY_SELECTOR =
  '[role=tooltip],[role=menu],[role=listbox],[role=dialog],[role=alertdialog],[data-state="open"],[popover],.dropdown-menu,.popover,.tooltip';
const OVERLAY_ITEMS =
  'a[href],button,input:not([type=hidden]),select,textarea,[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=link],[role=button],[role=checkbox],[role=switch],[tabindex]:not([tabindex="-1"])';

const OVERLAYS_JS = `const overlays = () => {
    const shown = (el) => {
      if (!el.getClientRects || el.getClientRects().length === 0) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      if (el.hasAttribute("popover")) {
        try { return el.matches(":popover-open"); } catch (e) { return true; }
      }
      return true;
    };
    return Array.from(document.querySelectorAll(${JSON.stringify(OVERLAY_SELECTOR)})).filter(shown);
  };`;

export const HOVER_MARK = `() => {
  ${OVERLAYS_JS}
  const seen = new WeakSet();
  for (const el of overlays()) seen.add(el);
  globalThis[Symbol.for("ardia.hoverBefore")] = seen;
  return true;
}`;

export const HOVER_REVEALED = `() => {
  ${OVERLAYS_JS}
  const seen = globalThis[Symbol.for("ardia.hoverBefore")] || new WeakSet();
  const fresh = overlays().filter((el) => !seen.has(el));
  const roots = fresh.filter((el) => !fresh.some((other) => other !== el && other.contains(el)));
  const out = [];
  for (const root of roots) {
    const items = Array.from(root.querySelectorAll(${JSON.stringify(OVERLAY_ITEMS)})).filter((el) => el.getClientRects().length > 0);
    if (items.length === 0) out.push(root);
    else out.push(...items);
    if (out.length >= ${MAX_REVEALED}) break;
  }
  return out.slice(0, ${MAX_REVEALED});
}`;

export const DESCRIBE_REVEALED = `(el) => {
  const implicit = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", LI: "listitem", OPTION: "option" };
  let role = (el.getAttribute("role") || "").trim().split(/\\s+/)[0] || "";
  if (!role && el.tagName === "INPUT") role = ["checkbox", "radio"].includes(el.type) ? el.type : el.type === "submit" || el.type === "button" ? "button" : "textbox";
  if (!role) role = implicit[el.tagName] || (el.classList.contains("tooltip") ? "tooltip" : el.classList.contains("popover") ? "dialog" : el.classList.contains("dropdown-menu") ? "menu" : "generic");
  const label = el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.value || "";
  return { role, name: String(label).replace(/\\s+/g, " ").trim().slice(0, 80) };
}`;

export type Revealed = { ref: string; role: string; name: string };

export async function markOverlays(page: Page, frame: string): Promise<boolean> {
  try {
    await page.call(HOVER_MARK, [], { frame, read: true });
    return true;
  } catch (error) {
    if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
    return false;
  }
}

export async function revealedAfter(ctx: Ctx, page: Page, frame: string, polls: readonly number[] = REVEAL_POLLS_MS): Promise<Revealed[]> {
  for (const wait of polls) {
    await sleep(wait / 1000);
    let elements: Element[];
    try {
      const remote = await page.call(HOVER_REVEALED, [], { frame, byValue: false, read: true });
      elements = await page.elementsFrom(remote, frame, "revealed by hover", MAX_REVEALED);
    } catch (error) {
      if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
      return [];
    }
    if (elements.length === 0) continue;
    const revealed: Revealed[] = [];
    for (const element of elements) {
      let facts: Record<string, unknown> = {};
      try {
        const described = await page.call(DESCRIBE_REVEALED, [element], { frame: element.frame, read: true });
        if (described !== null && typeof described === "object") facts = described as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
      }
      const role = String(facts["role"] ?? "generic");
      const name = String(facts["name"] ?? "");
      revealed.push({ ref: ctx.state.addRef(page, element, role, name), role, name });
    }
    flag("hover_revealed", true);
    count("hover_revealed_items", revealed.length);
    return revealed;
  }
  return [];
}

export function revealedLines(revealed: readonly Revealed[]): string[] {
  if (revealed.length === 0) return [];
  return ["revealed:", ...revealed.map((item) => `  @${item.ref} ${item.role}${item.name ? ` "${item.name}"` : ""}`)];
}

export function hoverResult(selector: string, revealed: readonly Revealed[]): Result {
  if (revealed.length === 0) return new Result({ hovered: selector });
  return new Result({ hovered: selector, revealed }, ["✓ Done", ...revealedLines(revealed)].join("\n"), true);
}
