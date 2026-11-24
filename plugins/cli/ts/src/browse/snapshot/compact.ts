import { joinedWords, pyLen, pyRstrip, headPoints } from "../../pylib/str.ts";
import { INTERACTIVE, Node, REF_ROLES } from "./tree.ts";

export const WRAPPERS = new Set(["generic", "group", "none", "presentation", "Section", "div", "GenericContainer", "listitem", "Pre", "Abbr"]);
export const TEXT_WRAPPERS = new Set(["paragraph", "Paragraph", "strong", "emphasis", "mark", "code", "time", "Time"]);
export const MAX_NOTE = 40;

function copied(node: Node, children: Node[]): Node {
  return new Node(node.role, node.name, node.value, node.props, node.backend, children, node.ref, node.hints, node.url, node.frame, node.boxless);
}

function textOf(node: Node): string {
  if (node.role === "StaticText") return node.name;
  return node.children.map(textOf).join(" ");
}

function plainContainer(node: Node): boolean {
  return !node.ref && !(node.hints && node.hints.length) && !node.value && node.props.get("level") === undefined;
}

function onlyText(nodes: readonly Node[]): boolean {
  return nodes.length > 0 && nodes.every((child) => child.role === "StaticText" || (WRAPPERS.has(child.role) && plainContainer(child) && !child.name && onlyText(child.children)));
}

export const LEAN_LIFTED = new Set(["LabelText", "MenuListPopup", "rowgroup"]);
const LABEL_TAIL = /[\s:*]+$/u;

export type Trimmed = { lines: number };

function labelKey(text: string): string {
  return joinedWords(text).replace(LABEL_TAIL, "").toLowerCase();
}

function lineCount(node: Node): number {
  return 1 + node.children.reduce((sum, child) => sum + lineCount(child), 0);
}

function echoesControl(node: Node, controls: ReadonlySet<string>): boolean {
  if (node.ref || (node.hints && node.hints.length)) return false;
  if (node.role === "StaticText") return controls.has(labelKey(node.name));
  return node.role === "LabelText" && plainContainer(node) && onlyText(node.children) && controls.has(labelKey(textOf(node)));
}

function withoutEchoes(node: Node, children: Node[], trimmed: Trimmed): Node[] {
  const value = joinedWords(node.value);
  let kept = children;
  if (value && (node.ref || INTERACTIVE.has(node.role))) {
    kept = kept.filter((child) => {
      const echo = child.role === "StaticText" && !child.ref && joinedWords(child.name) === value;
      if (echo) trimmed.lines += 1;
      return !echo;
    });
  }
  const controls = new Set(kept.filter((child) => child.ref && INTERACTIVE.has(child.role) && joinedWords(child.name)).map((child) => labelKey(child.name)));
  if (controls.size === 0) return kept;
  return kept.filter((child) => {
    const echo = echoesControl(child, controls);
    if (echo) trimmed.lines += lineCount(child);
    return !echo;
  });
}

export function compactTree(nodes: readonly Node[], lean = false, trimmed: Trimmed = { lines: 0 }): Node[] {
  const visit = (node: Node, insideRef: boolean): Node[] => {
    let ref = node.ref;
    let hints = node.hints;
    if (insideRef && hints && hints.length) {
      hints = null;
      if (!REF_ROLES.has(node.role)) ref = null;
    }
    const holdsRef = insideRef || Boolean(ref);
    let children = node.children.flatMap((child) => visit(child, holdsRef));
    if (lean) {
      children = withoutEchoes(node, children, trimmed);
      if (!node.name && !ref && !(hints && hints.length) && !node.value && LEAN_LIFTED.has(node.role) && node.props.get("level") === undefined) {
        trimmed.lines += 1;
        return children;
      }
    }
    let name = node.name;
    const squashedName = joinedWords(name);
    if (squashedName && children.length > 0) {
      const childText = joinedWords(children.map(textOf).join(" "));
      if (childText === squashedName) {
        if (ref || node.role === "heading" || INTERACTIVE.has(node.role)) {
          if (onlyText(children)) children = [];
        } else if (children.length > 1 || children[0]?.role !== "StaticText") name = "";
      }
    }
    const shaped = copied(node, children);
    shaped.ref = ref;
    shaped.hints = hints;
    shaped.name = name;
    if (!shaped.name && plainContainer(shaped) && (WRAPPERS.has(shaped.role) || TEXT_WRAPPERS.has(shaped.role)) && children.length === 0) return [];
    if (!shaped.name && plainContainer(shaped) && WRAPPERS.has(shaped.role) && children.length === 1) return children;
    if (!shaped.name && plainContainer(shaped) && TEXT_WRAPPERS.has(shaped.role) && children.length === 1 && children[0]?.role === "StaticText") return children;
    return [shaped];
  };
  return nodes.flatMap((node) => visit(node, false));
}

export type Ambiguous = { node: Node; nameless: boolean };

export function ambiguousControls(nodes: readonly Node[]): Ambiguous[] {
  const controls: Node[] = [];
  const stack = [...nodes].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.ref && (INTERACTIVE.has(node.role) || (node.hints && node.hints.length))) controls.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index] as Node);
  }
  const keyOf = (node: Node) => JSON.stringify([node.role, joinedWords(node.name)]);
  const counts = new Map<string, number>();
  for (const node of controls) counts.set(keyOf(node), (counts.get(keyOf(node)) ?? 0) + 1);
  return controls.filter((node) => !joinedWords(node.name) || (counts.get(keyOf(node)) as number) > 1).map((node) => ({ node, nameless: !joinedWords(node.name) }));
}

export type Clue = { testid?: string | null; icon?: string | null; alt?: string | null };

function short(text: string): string {
  const flat = joinedWords(text);
  return pyLen(flat) <= MAX_NOTE ? flat : `${pyRstrip(headPoints(flat, MAX_NOTE - 1))}…`;
}

function quote(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function noteOf(clue: Clue, nameless: boolean, near: string | null): string | null {
  const order: [string, string | null | undefined][] = nameless
    ? [["icon", clue.icon], ["img", clue.alt], ["testid", clue.testid], ["near", near]]
    : [["near", near], ["testid", clue.testid], ["icon", clue.icon], ["img", clue.alt]];
  for (const [kind, value] of order) {
    if (value && joinedWords(value)) return `${kind} ${quote(short(value))}`;
  }
  return null;
}

export const CLUE_OF = `(el) => {
  const pick = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const testid = pick(el.getAttribute("data-testid")) || pick(el.getAttribute("data-test")) || pick(el.getAttribute("data-qa")) || pick(el.getAttribute("data-cy"))
    || pick(el.querySelector("[data-testid]")?.getAttribute("data-testid"));
  const img = el.matches("img[alt]") ? el : el.querySelector("img[alt]");
  const alt = img ? pick(img.getAttribute("alt")) : null;
  let icon = pick(el.getAttribute("data-icon")) || pick(el.querySelector("[data-icon]")?.getAttribute("data-icon"));
  if (!icon) {
    const use = el.querySelector("svg use");
    const href = use && (use.getAttribute("href") || use.getAttribute("xlink:href"));
    if (href && href.includes("#")) icon = pick(href.slice(href.lastIndexOf("#") + 1));
  }
  if (!icon) {
    const title = el.querySelector("svg title");
    icon = title ? pick(title.textContent) : null;
  }
  if (!icon) {
    for (const part of [el, ...el.querySelectorAll("i, span, svg")].slice(0, 12)) {
      const classes = typeof part.className === "string" ? part.className : part.getAttribute("class") || "";
      if (/material-(icons|symbols)/.test(classes) && part.textContent.trim()) { icon = part.textContent.trim(); break; }
      const found = /(?:^|\\s)(?:fa|fas|far|bi|mdi|icon|lucide|ti|ph)-([a-z0-9-]+)/i.exec(classes);
      if (found && !/^(solid|regular|light|brands|lg|sm|xs|fw|\\dx)$/.test(found[1])) { icon = found[1]; break; }
    }
  }
  return { testid, icon, alt };
}`;
