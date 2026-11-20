import { BrowseError } from "../daemon-errors.ts";
import { add } from "../metrics.ts";
import { type Node, walk } from "../snapshot/tree.ts";
import { describe, type Described, type Element } from "./dom.ts";
import { unavailable } from "./link.ts";
import { type PluginPage } from "./page.ts";

export const PROTECTED_PROP = "pluginProtected";
export const PROTECTED_NOTE = "(password field)";
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const MASKED = /^\u2022+$/u;
const INPUT_TAG = /<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu;
const PASSWORD_TYPE = /\stype\s*=\s*(?:"password"|'password'|password(?=[\s/>]))/iu;
const VALUE_ATTRIBUTE = /\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/giu;

export class ProtectedField extends BrowseError {
  override readonly exitCode: number = 77;

  constructor() {
    super("Password fields are filled by the password manager, not by plugins", null, "protected_field");
  }
}

export function passwordInput(described: Described): boolean {
  return described.tag === "input" && (described.attributes.get("type") ?? "").trim().toLowerCase() === "password";
}

function axProtected(node: Node): boolean {
  const value = node.props.get("protected");
  return value === true || value === "true";
}

async function describedAt(page: PluginPage, backend: number): Promise<Described | null> {
  try {
    return await describe({ page, backend, frame: "", label: "", role: "", name: "" });
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
}

export function markProtected(node: Node): void {
  node.props.set(PROTECTED_PROP, true);
  node.value = "";
  node.children = [];
}

export async function markProtectedFields(page: PluginPage, nodes: readonly Node[]): Promise<void> {
  for (const node of walk(nodes)) {
    if (node.props.get(PROTECTED_PROP)) continue;
    if (axProtected(node) || (FIELD_ROLES.has(node.role) && MASKED.test(node.value))) {
      markProtected(node);
      continue;
    }
    if (!FIELD_ROLES.has(node.role) || node.backend === null) continue;
    const described = await describedAt(page, node.backend);
    if (described !== null && passwordInput(described)) markProtected(node);
  }
}

export async function isProtected(element: Element, described?: Described): Promise<boolean> {
  const found = described ?? (await describe(element));
  return passwordInput(found);
}

export async function refuseProtected(element: Element, described?: Described): Promise<void> {
  if (!(await isProtected(element, described))) return;
  add("plugin_protected_refused");
  throw new ProtectedField();
}

export function scrubPasswordValues(html: string): string {
  return html.replace(INPUT_TAG, (tag) => (PASSWORD_TYPE.test(tag) ? tag.replace(VALUE_ATTRIBUTE, "") : tag));
}
