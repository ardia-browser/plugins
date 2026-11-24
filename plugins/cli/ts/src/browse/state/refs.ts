import { BrowseError, ConnectionLost, StaleRef, SUPERSEDED } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "./page.ts";

export const NAVIGATED_REFS_KEPT = 4000;
export const OPEN_REPLACED_KEPT = 16;
export const OPEN_TITLE_SHOWN = 80;
export const SHOWN_MATCHES = 6;

export type Redrawn = { unique: Ref | null; followable: Ref | null; same: string[]; sameRole: string[] };

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
  scope?: string;
  epoch?: number;
};

export type Vocabulary = { epoch: number; loader: string };

export interface Epochs {
  vocabulary(state: Refs, target: string, frame: string): Vocabulary | null;
  forget(state: Refs, target: string): void;
}

export type SnapshotNode = { ref?: string | null; role: string; name: string; boxless?: boolean };

export interface Snapshots {
  collect(state: Refs, page: Page): Promise<unknown>;
  refsOf(state: Refs, page: Page, nodes: unknown): Ref[];
  walk(nodes: unknown): Iterable<SnapshotNode>;
}

type RefKey = [string | null, string, string, string, number];

const REF_ID = /^(?:f[0-9]+)?e[0-9]+$/u;

export function sameScope(old: Ref, fresh: Ref): boolean {
  return (
    old.unique &&
    fresh.target === old.target &&
    fresh.frame === old.frame &&
    (fresh.scope ?? "[]") === (old.scope ?? "[]") &&
    JSON.stringify(fresh.context) === JSON.stringify(old.context)
  );
}

export function isRefId(text: string): boolean {
  return REF_ID.test(text);
}

export function refNumber(refId: string): number | null {
  if (!isRefId(refId)) return null;
  return Number(refId.slice(refId.lastIndexOf("e") + 1));
}

export function parseRef(selector: string): string | null {
  if (selector.startsWith("@") && isRefId(selector.slice(1))) return selector.slice(1);
  if (selector.startsWith("ref=") && isRefId(selector.slice(4))) return selector.slice(4);
  if (selector.startsWith("[ref=") && selector.endsWith("]") && isRefId(selector.slice(5, -1))) return selector.slice(5, -1);
  if (isBareRef(selector)) return selector;
  return null;
}

export function isBareRef(selector: string): boolean {
  return isRefId(selector);
}

export abstract class Refs {
  static snapshots: Snapshots | null = null;
  static epochs: Epochs | null = null;

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
  readonly frameOrdinals = new Map<string, number>();
  readonly framesPerTab = new Map<string, number>();

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
      SUPERSEDED,
    );
  }

  elementCode(ref: Ref): string {
    const now = Refs.epochs?.vocabulary(this, ref.target, ref.frame) ?? null;
    return now !== null && ref.epoch !== undefined && now.loader === ref.loader && now.epoch > ref.epoch ? SUPERSEDED : "stale_ref";
  }

  forgetTabFrames(target: string): void {
    for (const key of [...this.frameOrdinals.keys()]) if ((JSON.parse(key) as [string | null, string, string])[1] === target) this.frameOrdinals.delete(key);
    for (const key of [...this.framesPerTab.keys()]) if ((JSON.parse(key) as [string | null, string])[1] === target) this.framesPerTab.delete(key);
    Refs.epochs?.forget(this, target);
  }

  setRefs(refs: Ref[], snapshotText: string | null, page: Page | null = null): void {
    this.generation += 1;
    if (page !== null) this.pruneRefs(page);
    for (const ref of refs) {
      ref.generation = this.generation;
      if (ref.epoch === undefined) {
        const kept = this.refs.get(ref.id)?.epoch;
        if (kept !== undefined) ref.epoch = kept;
      }
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

  nextRef(prefix = ""): string {
    this.issuedRefs += 1;
    return `${prefix}e${this.issuedRefs}`;
  }

  framePrefix(page: Page, frame: string): string {
    if (!page.frameSessions.has(frame)) return "";
    const key = JSON.stringify([this.instance, page.targetId, frame]);
    let ordinal = this.frameOrdinals.get(key);
    if (ordinal === undefined) {
      const tab = JSON.stringify([this.instance, page.targetId]);
      ordinal = (this.framesPerTab.get(tab) ?? 0) + 1;
      this.framesPerTab.set(tab, ordinal);
      this.frameOrdinals.set(key, ordinal);
    }
    return `f${ordinal}`;
  }

  refForNode(page: Page, frame: string, backend: number): string {
    const key: RefKey = [this.instance, page.targetId, frame, page.loader(frame) || "", backend];
    const text = JSON.stringify(key);
    let entry = this.refKeys.get(text);
    if (entry === undefined) {
      entry = [key, this.nextRef(this.framePrefix(page, frame))];
      this.refKeys.set(text, entry);
    }
    return entry[1];
  }

  knownRef(page: Page, frame: string, backend: number): Ref | null {
    const entry = this.refKeys.get(JSON.stringify([this.instance, page.targetId, frame, page.loader(frame) || "", backend]));
    return entry === undefined ? null : (this.refs.get(entry[1]) ?? null);
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
      ...(known?.scope !== undefined ? { scope: known.scope } : {}),
      ...(known?.epoch !== undefined ? { epoch: known.epoch } : {}),
    });
    return id;
  }

  async resolveRef(refId: string): Promise<[Page, Element]> {
    const ref = this.refs.get(refId);
    if (ref === undefined) {
      const old = this.navigatedRefs.get(refId);
      if (old !== undefined) throw this.staleAfterOpen(old) ?? new StaleRef(refId, await this.afterNavigation(old), null, SUPERSEDED);
      const issued = refNumber(refId);
      if (issued !== null && issued <= this.issuedRefs) throw new StaleRef(refId, "it came from an earlier snapshot, and refs are never reused");
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
    if (frame.loader !== ref.loader) throw this.staleAfterOpen(ref) ?? new StaleRef(refId, "the page navigated since that snapshot", null, SUPERSEDED);
    const element = await page.resolveBackend(ref.backend, ref.frame, `@${refId}`);
    let gone: string;
    if (element === null) gone = "the element is no longer in the page";
    else if (!(await page.call("(el) => el.isConnected", [element], { frame: ref.frame }))) gone = "the element was removed from the page";
    else return [page, element];
    const found = await this.redrawnAll(page, ref);
    const successor = found.unique;
    if (successor === null) {
      const code = this.elementCode(ref);
      const missing = new StaleRef(refId, code === SUPERSEDED ? `${gone}, and the page has nothing in common with that snapshot any more` : gone, null, code);
      const named = found.same.filter((id) => this.refs.has(id));
      missing.ambiguous = named.length > 1;
      missing.matches = (named.length > 1 ? named : code === SUPERSEDED ? [] : found.sameRole.filter((id) => this.refs.has(id))).slice(0, SHOWN_MATCHES);
      throw missing;
    }
    const redrawn = new StaleRef(refId, `${gone}; the page redrew it, and the same ${ref.role} "${ref.name}" is now @${successor.id}`);
    redrawn.successor = found.followable === null ? null : found.followable.id;
    if (found.followable === null) redrawn.matches = [successor.id];
    throw redrawn;
  }

  async afterNavigation(old: Ref): Promise<string> {
    const why = "the page navigated since that snapshot (an earlier step loaded a new document)";
    const page = this.pages.get(old.target);
    if (page === undefined) return why;
    flag("stale_ref_after_navigation", true);
    let successor: Ref | null;
    try {
      successor = (await this.redrawnAll(page, old)).unique;
    } catch (error) {
      if (error instanceof ConnectionLost || !(error instanceof BrowseError)) throw error;
      successor = null;
    }
    if (successor === null) return why;
    return `${why}; the new page has the same ${old.role} "${old.name}" as @${successor.id}, if it is the one you meant`;
  }

  async redrawn(page: Page, ref: Ref): Promise<Ref | null> {
    return (await this.redrawnAll(page, ref)).unique;
  }

  async redrawnAll(page: Page, ref: Ref): Promise<Redrawn> {
    const none: Redrawn = { unique: null, followable: null, same: [], sameRole: [] };
    const snapshots = Refs.snapshots;
    if (!ref.role || !ref.name || snapshots === null) return none;
    let nodes: unknown;
    try {
      nodes = await snapshots.collect(this, page);
      this.setRefs(snapshots.refsOf(this, page, nodes), null, page);
    } catch (error) {
      if (error instanceof ConnectionLost) throw error;
      if (error instanceof Error && error.name === "CancelledError") throw error;
      return none;
    }
    const walked = [...snapshots.walk(nodes)];
    const same = walked.filter((node) => (node.ref || node.boxless) && node.role === ref.role && node.name === ref.name).map((node) => node.ref ?? null);
    const sameRole = walked.filter((node) => node.ref && node.role === ref.role && node.name).map((node) => node.ref as string);
    const unique = same.length === 1 && same[0] ? (this.refs.get(same[0]) ?? null) : null;
    const followable = unique !== null && sameScope(ref, unique) ? unique : null;
    return { unique, followable, same: same.filter((id): id is string => id !== null), sameRole };
  }

  refsJson(): Record<string, { name: string; role: string }> {
    return Object.fromEntries(this.snapshotRefs().map((ref) => [ref.id, { name: ref.name, role: ref.role }]));
  }
}
