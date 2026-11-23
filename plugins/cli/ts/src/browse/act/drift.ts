import { BrowseError, CdpError, Gated } from "../daemon-errors.ts";
import { add, flag } from "../metrics.ts";
import { type AxNode, buildTree, isAxList } from "../snapshot/tree.ts";
import type { Element, Page } from "../state/page.ts";
import { parseRef, type Ref } from "../state/refs.ts";

export type Identity = { role: string; name: string };
export type Drift = { field: "role" | "name" | "both"; was: Identity; now: Identity };

export const DRIFT_GUARDED = new Set(["click", "dblclick", "fill", "type", "press", "check", "uncheck", "select", "drag", "upload", "download", "hover", "focus", "tap"]);

function squash(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function driftBetween(was: Identity, now: Identity | null): Drift | null {
  if (now === null || !was.role) return null;
  const roleChanged = was.role !== now.role;
  const nameChanged = squash(was.name) !== squash(now.name);
  if (!roleChanged && !nameChanged) return null;
  return { field: roleChanged && nameChanged ? "both" : roleChanged ? "role" : "name", was, now };
}

export function describeIdentity(identity: Identity): string {
  return identity.name ? `${identity.role} "${identity.name}"` : `${identity.role} with no name`;
}

export function driftMessage(ref: string, action: string, drift: Drift): string {
  const what = drift.field === "role" ? "its role" : drift.field === "name" ? "its name" : "its role and name";
  return (
    `@${ref} changed since it was last seen, so ${action} wasn't sent: ${what} went from ${describeIdentity(drift.was)} to ` +
    `${describeIdentity(drift.now)}. The page may have reused that element for something else. Snapshot again (snapshot -i), ` +
    "check it is still the one you mean, then use its ref"
  );
}

export function identityOf(nodes: readonly AxNode[], backend: number): Identity | null {
  const found = buildTree(nodes, backend);
  const node = found.find((item) => item.backend === backend) ?? null;
  return node === null ? null : { role: node.role, name: node.name };
}

export async function currentIdentity(page: Page, element: Element): Promise<Identity | null> {
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
  return isAxList(nodes) ? identityOf(nodes, element.backendId) : null;
}

export async function refuseDrift(page: Page, element: Element, ref: Ref | undefined, action: string): Promise<void> {
  if (ref === undefined || !ref.role || ref.backend !== element.backendId) return;
  let now: Identity | null;
  try {
    now = await currentIdentity(page, element);
  } catch (error) {
    if (error instanceof BrowseError && error.code !== "connection_lost") return;
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
