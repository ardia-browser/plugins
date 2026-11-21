import { noteShown, remember } from "../changes/views.ts";
import type { Page } from "../state/page.ts";
import type { Ref } from "../state/refs.ts";
import type { State } from "../state/state.ts";
import { collect, linkUrls, refsOf } from "./collect.ts";
import { render } from "./render.ts";
import { walk } from "./tree.ts";

export type TakeOptions = { interactive?: boolean; compact?: boolean; depth?: number | null; selector?: string | null; urls?: boolean; cursor?: boolean };

export async function take(state: State, page: Page, options: TakeOptions = {}): Promise<[string, Ref[]]> {
  const { interactive = false, compact = false, depth = null, selector = null, urls = false, cursor = true } = options;
  const nodes = await collect(state, page, selector, cursor);
  if (urls) {
    const frames = [...new Set([...walk(nodes)].map((node) => node.frame as string))];
    for (const used of frames) await linkUrls(page, [...walk(nodes)].filter((node) => node.frame === used), used);
  }
  const text = render(nodes, { interactive, compact, depth, urls });
  const refs = refsOf(state, page, nodes, !selector);
  const whole = !(depth !== null || selector);
  state.setRefs(refs, text, page);
  if (whole) noteShown(state, await remember(state, page, nodes));
  return [text, refs];
}
