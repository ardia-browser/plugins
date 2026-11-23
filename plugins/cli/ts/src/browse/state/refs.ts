import { BrowseError, ConnectionLost, StaleRef } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "./page.ts";

export const NAVIGATED_REFS_KEPT = 4000;
export const OPEN_REPLACED_KEPT = 16;
export const OPEN_TITLE_SHOWN = 80;

export type OpenReplaced = { target: string; documents: Set<string>; from: string; to: string };

function documentKey(frame: string, loader: string): string {
  return JSON.stringify([frame, loader]);
}

function shownTitle(title: string): string {
  const chars = [...title.replace(/\s+/gu, " ").trim()];
  return chars.length > OPEN_TITLE_SHOWN ? `${chars.slice(0, OPEN_TITLE_SHOWN - 1).join("")}…` : chars.join("");
}

export type Ref = {
  id: string;
  instance: string | null;
  target: string;
  frame: string;
  loader: string;
  generation: number;
  backend: number;
  role: string;
  name: string;
  unique: boolean;
  context: readonly unknown[];
};

export type SnapshotNode = { ref?: string | null; role: string; name: string };

export interface Snapshots {
  collect(state: Refs, page: Page): Promise<unknown>;
  refsOf(state: Refs, page: Page, nodes: unknown): Ref[];
  walk(nodes: unknown): Iterable<SnapshotNode>;
}

type RefKey = [string | null, string, string, string, number];

function digits(text: string): boolean {
  return /^[0-9]+$/u.test(text);
}

export function parseRef(selector: string): string | null {
  if (selector.startsWith("@") && selector.slice(1, 2) === "e" && digits(selector.slice(2))) return selector.slice(1);
  if (selector.startsWith("ref=") && selector.slice(4, 5) === "e" && digits(selector.slice(5))) return selector.slice(4);
  if (selector.startsWith("[ref=") && selector.endsWith("]") && selector.slice(5, 6) === "e" && digits(selector.slice(6, -1))) return selector.slice(5, -1);
  return null;
}

export abstract class Refs {
  static snapshots: Snapshots | null = null;

  abstract instance: string | null;
  abstract readonly pages: Map<string, Page>;
  abstract targetInfos: Map<string, Record<string, unknown>>;
  abstract page(target?: string | null): Promise<Page>;

  readonly refs = new Map<string, Ref>();
  issuedRefs = 0;
  readonly refKeys = new Map<string, [RefKey, string]>();
  readonly navigatedRefs = new Map<string, Ref>();
  currentRefs: string[] = [];
  generation = 0;
  lastSnapshot: string | null = null;
  readonly openReplaced: OpenReplaced[] = [];

  documentsOf(page: Page): Set<string> {
    return new Set([...page.frames].filter(([, frame]) => frame.loader).map(([frameId, frame]) => documentKey(frameId, frame.loader as string)));
  }

  noteOpenReplaced(page: Page, documents: Set<string>, from: string, to: string): void {
    const now = this.documentsOf(page);
    const replaced = new Set([...documents].filter((key) => !now.has(key)));
    if (replaced.size === 0) return;
    this.openReplaced.push({ target: page.targetId, documents: replaced, from: shownTitle(from), to: shownTitle(to) });
    while (this.openReplaced.length > OPEN_REPLACED_KEPT) this.openReplaced.shift();
  }

  staleAfterOpen(ref: Ref): StaleRef | null {
    const key = documentKey(ref.frame, ref.loader);
    const replaced = this.openReplaced.find((entry) => entry.target === ref.target && entry.documents.has(key));
    if (replaced === undefined) return null;
    flag("stale_ref_after_open", true);
    return new StaleRef(
      ref.id,
      `it was on "${replaced.from}"; \`open\` replaced it in this tab with "${replaced.to}"`,
      "To keep both pages, open the second with `ardia browse tab new <url>`",
    );
  }

  setRefs(refs: Ref[], snapshotText: string | null, page: Page | null = null): void {
    this.generation += 1;
    if (page !== null) this.pruneRefs(page);
    for (const ref of refs) {
      ref.generation = this.generation;
      this.refs.set(ref.id, ref);
    }
    this.currentRefs = refs.map((ref) => ref.id);
    if (snapshotText !== null) this.lastSnapshot = snapshotText;
  }

  pruneRefs(page: Page): void {
    const live = new Set([...page.frames].map(([frameId, frame]) => JSON.stringify([frameId, frame.loader])));
    for (const [text, [key, refId]] of [...this.refKeys]) {
      const [instance, target, frame, loader] = key;
      if (instance !== this.instance || (target === page.targetId && !live.has(JSON.stringify([frame, loader])))) {
        this.refKeys.delete(text);
        const gone = this.refs.get(refId);
        this.refs.delete(refId);
        if (gone !== undefined && instance === this.instance) {
          this.navigatedRefs.delete(refId);
          this.navigatedRefs.set(refId, gone);
        }
      }
    }
    while (this.navigatedRefs.size > NAVIGATED_REFS_KEPT) this.navigatedRefs.delete(this.navigatedRefs.keys().next().value as string);
  }

  nextRef(): string {
    this.issuedRefs += 1;
    return `e${this.issuedRefs}`;
  }

  refForNode(page: Page, frame: string, backend: number): string {
    const key: RefKey = [this.instance, page.targetId, frame, page.loader(frame) || "", backend];
    const text = JSON.stringify(key);
    let entry = this.refKeys.get(text);
    if (entry === undefined) {
      entry = [key, this.nextRef()];
      this.refKeys.set(text, entry);
    }
    return entry[1];
  }

  snapshotRefs(): Ref[] {
    return this.currentRefs.filter((id) => this.refs.has(id)).map((id) => this.refs.get(id) as Ref);
  }

  addRef(page: Page, element: Element, role = "", name = ""): string {
    const id = this.refForNode(page, element.frame, element.backendId);
    const known = this.refs.get(id);
    this.refs.set(id, {
      id,
      instance: this.instance,
      target: page.targetId,
      frame: element.frame,
      loader: page.loader(element.frame) || "",
      generation: this.generation,
      backend: element.backendId,
      role: role || (known?.role ?? ""),
      name: name || (known?.name ?? ""),
      unique: Boolean(known?.unique),
      context: known?.context ?? [],
    });
    return id;
  }

  async resolveRef(refId: string): Promise<[Page, Element]> {
    const ref = this.refs.get(refId);
    if (ref === undefined) {
      const old = this.navigatedRefs.get(refId);
      if (old !== undefined) throw this.staleAfterOpen(old) ?? new StaleRef(refId, await this.afterNavigation(old));
      if (digits(refId.slice(1)) && Number(refId.slice(1)) <= this.issuedRefs) throw new StaleRef(refId, "it came from an earlier snapshot, and refs are never reused");
      throw new BrowseError(`Unknown ref: ${refId}`, null, "unknown_ref");
    }
    if (ref.instance !== this.instance) throw new StaleRef(refId, "Ardia restarted since that snapshot");
    if (!this.targetInfos.has(ref.target) && !this.pages.has(ref.target)) throw new StaleRef(refId, "its tab was closed");
    let page: Page;
    try {
      page = await this.page(ref.target);
    } catch (error) {
      if (error instanceof BrowseError && error.code === "tab_gone") throw new StaleRef(refId, "its tab was closed");
      throw error;
    }
    await page.refreshFrames();
    const frame = page.frames.get(ref.frame);
    if (frame === undefined) throw this.staleAfterOpen(ref) ?? new StaleRef(refId, "its frame is gone");
    if (frame.loader !== ref.loader) throw this.staleAfterOpen(ref) ?? new StaleRef(refId, "the page navigated since that snapshot");
    const element = await page.resolveBackend(ref.backend, ref.frame, `@${refId}`);
    let gone: string;
    if (element === null) gone = "the element is no longer in the page";
    else if (!(await page.call("(el) => el.isConnected", [element], { frame: ref.frame }))) gone = "the element was removed from the page";
    else return [page, element];
    const successor = await this.redrawn(page, ref);
    if (successor === null) throw new StaleRef(refId, gone);
    throw new StaleRef(refId, `${gone}; the page redrew it, and the same ${ref.role} "${ref.name}" is now @${successor.id}`);
  }

  async afterNavigation(old: Ref): Promise<string> {
    const why = "the page navigated since that snapshot (an earlier step loaded a new document)";
    const page = this.pages.get(old.target);
    if (page === undefined) return why;
    flag("stale_ref_after_navigation", true);
    let successor: Ref | null;
    try {
      successor = await this.redrawn(page, old);
    } catch (error) {
      if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
      successor = null;
    }
    if (successor === null) return why;
    return `${why}; the new page has the same ${old.role} "${old.name}" as @${successor.id}, if it is the one you meant`;
  }

  async redrawn(page: Page, ref: Ref): Promise<Ref | null> {
    const snapshots = Refs.snapshots;
    if (!ref.role || !ref.name || snapshots === null) return null;
    let nodes: unknown;
    try {
      nodes = await snapshots.collect(this, page);
      this.setRefs(snapshots.refsOf(this, page, nodes), null, page);
    } catch (error) {
      if (error instanceof ConnectionLost) throw error;
      if (error instanceof Error && error.name === "CancelledError") throw error;
      return null;
    }
    const same = [...snapshots.walk(nodes)].filter((node) => node.ref && node.role === ref.role && node.name === ref.name).map((node) => node.ref as string);
    return same.length === 1 ? (this.refs.get(same[0] as string) ?? null) : null;
  }

  refsJson(): Record<string, { name: string; role: string }> {
    return Object.fromEntries(this.snapshotRefs().map((ref) => [ref.id, { name: ref.name, role: ref.role }]));
  }
}
