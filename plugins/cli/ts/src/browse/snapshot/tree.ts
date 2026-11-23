import { headPoints, pyStrip } from "../../pylib/str.ts";
import { get, isDict, pyStr, truthy } from "../../pylib/plain.ts";
import { redact } from "../../redact.ts";

export const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
  "slider", "spinbutton", "switch", "tab", "treeitem", "Iframe", "iframe",
]);
export const REF_ROLES = new Set([...INTERACTIVE, "heading"]);
export const SKIPPED = new Set(["none", "InlineTextBox", "LineBreak", "ListMarker"]);
export const LIFTED = new Set(["generic", "GenericContainer", "group", "Section", "div", "presentation", "RootWebArea", "WebArea", "Ignored", "IgnoredRole"]);
export const MAX_NAME = 200;
export const VALUE_FIELDS: Readonly<Record<string, string>> = { Date: "date", DateTime: "datetime-local", InputTime: "time", ColorWell: "color" };
export const ROLE_NAMES: Readonly<Record<string, string>> = { DisclosureTriangle: "button" };
export const MAX_SCOPES = 20;

export type Props = Map<string | null, unknown>;

export class Node {
  constructor(
    public role: string,
    public name = "",
    public value = "",
    public props: Props = new Map(),
    public backend: number | null = null,
    public children: Node[] = [],
    public ref: string | null = null,
    public hints: string[] | null = null,
    public url: string | null = null,
    public frame: string | null = null,
    public boxless = false,
  ) {}
}

export type AxNode = Record<string, unknown>;

export function axValue(item: unknown): string {
  if (!truthy(item)) return "";
  const value = get(item, "value");
  if (value === null || value === undefined) return "";
  return pyStr(value);
}

export function clipped(text: string): string {
  return headPoints(redact(text), MAX_NAME);
}

export function nodeProps(raw: AxNode): Props {
  const props: Props = new Map();
  const list = raw.properties;
  if (!truthy(list) || !Array.isArray(list)) return props;
  for (const prop of list) {
    const name = get(prop, "name");
    const holder = get(prop, "value");
    props.set(name === undefined ? null : (name as string | null), truthy(holder) ? (get(holder, "value") ?? null) : null);
  }
  return props;
}

function backendOf(raw: AxNode): number | null {
  const backend = raw.backendDOMNodeId;
  return typeof backend === "number" ? backend : null;
}

function valueField(raw: AxNode, role: string): Node {
  const props = nodeProps(raw);
  props.set("inputType", VALUE_FIELDS[role]);
  return new Node("textbox", clipped(pyStrip(axValue(raw.name))), clipped(axValue(raw.value)), props, backendOf(raw));
}

export function buildTree(axNodes: readonly AxNode[], scopeBackend: number | null = null): Node[] {
  const byId = new Map<unknown, AxNode>();
  for (const node of axNodes) byId.set(node.nodeId, node);
  let roots = axNodes.filter((node) => !truthy(node.parentId) || !byId.has(node.parentId));
  if (scopeBackend !== null) {
    const scoped = axNodes.filter((node) => node.backendDOMNodeId === scopeBackend);
    if (scoped.length === 0) return [];
    roots = scoped;
  }
  const convert = (raw: AxNode): Node[] => {
    const role = axValue(raw.role);
    if (Object.hasOwn(VALUE_FIELDS, role) && !truthy(raw.ignored)) return [valueField(raw, role)];
    const children: Node[] = [];
    const childIds = raw.childIds;
    if (truthy(childIds) && Array.isArray(childIds)) {
      for (const childId of childIds) {
        const child = byId.get(childId);
        if (child !== undefined) for (const converted of convert(child)) children.push(converted);
      }
    }
    if (truthy(raw.ignored) || SKIPPED.has(role)) return children;
    const name = role !== "StaticText" ? pyStrip(axValue(raw.name)) : axValue(raw.name);
    const props = nodeProps(raw);
    const shownRole = Object.hasOwn(ROLE_NAMES, role) ? (ROLE_NAMES[role] as string) : role;
    const node = new Node(shownRole, clipped(name), clipped(axValue(raw.value)), props, backendOf(raw), children);
    const backend = raw.backendDOMNodeId ?? null;
    if (LIFTED.has(shownRole) && !name && scopeBackend !== backend) node.role = "generic";
    return [node];
  };
  const out: Node[] = [];
  for (const root of roots) for (const node of convert(root)) out.push(node);
  const flat: Node[] = [];
  for (const node of out) {
    if (node.role === "RootWebArea" || node.role === "WebArea") flat.push(...node.children);
    else flat.push(node);
  }
  return flat;
}

export function* walk(nodes: readonly Node[]): Generator<Node> {
  const stack: Node[] = [...nodes].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    yield node;
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index] as Node);
  }
}

export const UNNAMED_CONTEXTS = new Set(["RootWebArea", "WebArea"]);

export type Context = readonly (readonly [string, string])[];

export function walkInContext(nodes: readonly Node[], context: Context = []): [Node, Context][] {
  const out: [Node, Context][] = [];
  const visit = (list: readonly Node[], here: Context) => {
    for (const node of list) {
      out.push([node, here]);
      const inner: Context = node.name && !UNNAMED_CONTEXTS.has(node.role) ? [...here, [node.role, node.name] as const] : here;
      visit(node.children, inner);
    }
  };
  visit(nodes, context);
  return out;
}

export function isAxList(value: unknown): value is AxNode[] {
  return Array.isArray(value) && value.every(isDict);
}
