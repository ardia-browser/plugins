import { BrowseError } from "../daemon-errors.ts";
import { clickAt } from "./input.ts";
import { unavailable } from "./link.ts";
import { type PluginPage } from "./page.ts";
import { type PluginSession } from "./session.ts";

export type Element = { page: PluginPage; backend: number; frame: string; label: string; role: string; name: string };
export type Described = { tag: string; attributes: Map<string, string> };
export type Box = { x: number; y: number; width: number; height: number };

const REF = /^(?:@|ref=)?(e[0-9]+)$/u;
const NOT_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden", "range", "color"]);

export function refId(selector: string): string | null {
  return REF.exec(selector)?.[1] ?? null;
}

export function isRefSelector(selector: string): boolean {
  return selector.startsWith("@") || selector.startsWith("ref=");
}

export async function locate(session: PluginSession, selector: string): Promise<Element> {
  const id = isRefSelector(selector) ? refId(selector) : null;
  if (isRefSelector(selector) && id === null) throw new BrowseError(`Unknown ref: ${selector.replace(/^@|^ref=/u, "")}`, null, "unknown_ref");
  if (id !== null) {
    const { page, ref } = await session.resolveRef(id);
    return { page, backend: ref.backend, frame: ref.frame, label: `@${id}`, role: ref.role, name: ref.name };
  }
  const page = await session.page();
  const backend = await queryBackend(page, selector);
  if (backend === null) {
    throw new BrowseError(`Element not found: ${selector}. Verify the selector, role, or name is correct and the element exists in the DOM.`, null, "not_found");
  }
  return { page, backend, frame: page.mainFrame ?? "", label: selector, role: "", name: "" };
}

export async function queryBackend(page: PluginPage, selector: string): Promise<number | null> {
  const root = (await page.send("DOM.getDocument", { depth: 0 }))["root"] as Record<string, unknown> | undefined;
  const rootId = root?.["nodeId"];
  if (typeof rootId !== "number") return null;
  let found: Record<string, unknown>;
  try {
    found = await page.send("DOM.querySelector", { nodeId: rootId, selector });
  } catch (error) {
    if (unavailable(error)) throw new BrowseError(`Invalid selector ${selector}: ${error.cdpMessage}`);
    throw error;
  }
  const nodeId = found["nodeId"];
  if (typeof nodeId !== "number" || nodeId === 0) return null;
  const node = (await page.send("DOM.describeNode", { nodeId }))["node"] as Record<string, unknown> | undefined;
  return typeof node?.["backendNodeId"] === "number" ? node["backendNodeId"] : null;
}

export async function describe(element: Element): Promise<Described> {
  const node = ((await element.page.send("DOM.describeNode", { backendNodeId: element.backend }))["node"] ?? {}) as Record<string, unknown>;
  const flat = Array.isArray(node["attributes"]) ? (node["attributes"] as unknown[]) : [];
  const attributes = new Map<string, string>();
  for (let index = 0; index + 1 < flat.length; index += 2) attributes.set(String(flat[index]).toLowerCase(), String(flat[index + 1]));
  return { tag: String(node["localName"] ?? node["nodeName"] ?? "").toLowerCase(), attributes };
}

export function editable(described: Described): boolean {
  const { tag, attributes } = described;
  if (attributes.has("disabled") || attributes.has("readonly")) return false;
  if (tag === "input") return !NOT_TEXT_INPUTS.has((attributes.get("type") ?? "text").toLowerCase());
  if (tag === "textarea") return true;
  const editableAttr = attributes.get("contenteditable");
  return editableAttr !== undefined && ["", "true", "plaintext-only"].includes(editableAttr.toLowerCase());
}

export function notEditable(element: Element, described: Described): string {
  const role = (described.attributes.get("role") || described.tag).toLowerCase();
  const name = element.name.trim().slice(0, 60);
  const named = name ? `${role} "${name}"` : role;
  if (described.tag === "select") return `${element.label} is a ${named}, not a text field; plugin mode can't pick from it yet`;
  return `${element.label} is a ${named}, which takes no typing; use click, select or check`;
}

function quadArea(quad: number[]): number {
  let area = 0;
  for (let index = 0; index < 8; index += 2) {
    const next = (index + 2) % 8;
    area += (quad[index] as number) * (quad[next + 1] as number) - (quad[next] as number) * (quad[index + 1] as number);
  }
  return Math.abs(area) / 2;
}

export async function quads(element: Element): Promise<number[][]> {
  const raw = (await element.page.send("DOM.getContentQuads", { backendNodeId: element.backend }))["quads"];
  return (Array.isArray(raw) ? raw : []).filter((quad): quad is number[] => Array.isArray(quad) && quad.length === 8 && quadArea(quad as number[]) > 1);
}

export async function center(element: Element): Promise<[number, number]> {
  await element.page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: element.backend });
  const found = await quads(element);
  const quad = found[0];
  if (quad === undefined) throw new BrowseError(`${element.label} has no box on the page (it's hidden, collapsed or not rendered)`, null, "not_visible");
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export async function boxOf(element: Element): Promise<Box | null> {
  let model: Record<string, unknown> | undefined;
  try {
    model = (await element.page.send("DOM.getBoxModel", { backendNodeId: element.backend }))["model"] as Record<string, unknown> | undefined;
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
  const border = model?.["border"];
  if (!Array.isArray(border) || border.length !== 8) return null;
  const xs = [border[0], border[2], border[4], border[6]] as number[];
  const ys = [border[1], border[3], border[5], border[7]] as number[];
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export async function focus(element: Element): Promise<void> {
  const [x, y] = await center(element);
  await clickAt(element.page, x, y, "left");
}
