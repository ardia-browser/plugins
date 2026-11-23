import { BrowseError, CdpError, ConnectionLost, Gated } from "../daemon-errors.ts";
import { add, flag } from "../metrics.ts";
import { INNER_TEXT } from "../snapshot/collect.ts";
import { type AxNode, buildTree, clipped, INTERACTIVE, isAxList, LIFTED } from "../snapshot/tree.ts";
import type { Element, Page } from "../state/page.ts";
import { parseRef, type Ref } from "../state/refs.ts";

export type Identity = { role: string; name: string };
export type Seen = Identity | "ignored" | null;
export type Drift = { field: "role" | "name" | "both" | "hidden"; was: Identity; now: Identity | null };

export const DRIFT_GUARDED = new Set(["click", "dblclick", "fill", "type", "press", "check", "uncheck", "select", "drag", "upload", "download", "hover", "focus", "tap"]);

function squash(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export const CONTAINER_ROLES: ReadonlySet<string> = new Set(["generic", ...LIFTED]);

export function sameRole(was: string, now: string): boolean {
  return was === now || (CONTAINER_ROLES.has(was) && CONTAINER_ROLES.has(now));
}

export function driftBetween(was: Identity, now: Seen): Drift | null {
  if (now === null || !was.role) return null;
  if (now === "ignored") return { field: "hidden", was, now: null };
  const roleChanged = !sameRole(was.role, now.role);
  const nameChanged = squash(was.name) !== squash(now.name);
  if (!roleChanged && !nameChanged) return null;
  return { field: roleChanged && nameChanged ? "both" : roleChanged ? "role" : "name", was, now };
}

export function describeIdentity(identity: Identity): string {
  return identity.name ? `${identity.role} "${identity.name}"` : `${identity.role} with no name`;
}

export function driftMessage(ref: string, action: string, drift: Drift): string {
  if (drift.field === "hidden" || drift.now === null) {
    return (
      `@${ref} changed since it was last seen, so ${action} wasn't sent: ${describeIdentity(drift.was)} is now hidden from the ` +
      "accessibility tree (aria-hidden, inert or no longer rendered), as when a dialog opens over it. Snapshot again (snapshot -i) " +
      "to see what's in front now"
    );
  }
  const what = drift.field === "role" ? "its role" : drift.field === "name" ? "its name" : "its role and name";
  return (
    `@${ref} changed since it was last seen, so ${action} wasn't sent: ${what} went from ${describeIdentity(drift.was)} to ` +
    `${describeIdentity(drift.now)}. The page may have reused that element for something else. Snapshot again (snapshot -i), ` +
    "check it is still the one you mean, then use its ref"
  );
}

export function identityOf(nodes: readonly AxNode[], backend: number): Seen {
  const own = nodes.find((node) => node.backendDOMNodeId === backend);
  if (own === undefined) return null;
  if (own.ignored === true) return "ignored";
  const found = buildTree(nodes.filter((node) => node.backendDOMNodeId === backend).map((node) => ({ ...node, parentId: undefined, childIds: [] })));
  const node = found.find((item) => item.backend === backend) ?? null;
  return node === null ? "ignored" : { role: node.role, name: node.name };
}

async function renderedText(page: Page, element: Element): Promise<string> {
  const text = await page.call(INNER_TEXT, [element], { frame: element.frame, read: true });
  return clipped(typeof text === "string" ? text : text ? String(text) : "");
}

export async function currentIdentity(page: Page, element: Element): Promise<Seen> {
  let result: Record<string, unknown>;
  try {
    result = await page.send(
      "Accessibility.getPartialAXTree",
      { backendNodeId: element.backendId, fetchRelatives: false },
      { session: page.sessionFor(element.frame), timeout: 5 },
    );
  } catch (error) {
    if (error instanceof CdpError || error instanceof Gated) return null;
    throw error;
  }
  const nodes = result["nodes"];
  const seen = isAxList(nodes) ? identityOf(nodes, element.backendId) : null;
  if (seen === null || seen === "ignored" || seen.name || INTERACTIVE.has(seen.role)) return seen;
  return { role: seen.role, name: await renderedText(page, element) };
}

export async function refuseDrift(page: Page, element: Element, ref: Ref | undefined, action: string): Promise<void> {
  if (ref === undefined || !ref.role || ref.backend !== element.backendId) return;
  let now: Seen;
  try {
    now = await currentIdentity(page, element);
  } catch (error) {
    if (error instanceof BrowseError && !(error instanceof ConnectionLost)) return;
    throw error;
  }
  const drift = driftBetween({ role: ref.role, name: ref.name }, now);
  if (drift === null) return;
  flag("ref_drift_refused", true);
  add("drift_refusals");
  throw new BrowseError(driftMessage(ref.id, action, drift), { ref: `@${ref.id}`, was: drift.was, now: drift.now, field: drift.field }, "ref_drifted");
}

export async function guardDrift(page: Page, element: Element, selector: string, command: string): Promise<void> {
  if (!DRIFT_GUARDED.has(command)) return;
  const id = parseRef(selector);
  if (id === null) return;
  await refuseDrift(page, element, page.state.refs.get(id), command);
}
