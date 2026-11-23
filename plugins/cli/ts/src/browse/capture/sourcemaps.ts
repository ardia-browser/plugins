import { createHash } from "node:crypto";
import { SourceMap } from "../../scripts/sourcemap.ts";
import type { Page } from "../state/page.ts";

export const MAX_INLINE_MAP_BYTES = 2 * 1024 * 1024;
export const MAX_CACHED_MAPS = 16;
export const MAX_CACHED_BYTES = 16 * 1024 * 1024;
const MAPPING_URL = /\/[/*][#@]\s*sourceMappingURL=([^\s'"*]+)\s*(?:\*\/)?\s*$/u;

export type LoadedMap = { map: SourceMap; sources: string[] };
export type Position = { url: string; line: number; column: number };
type Cached = { loaded: LoadedMap | null; bytes: number };

const MAPS = new WeakMap<Page, Map<string, Cached>>();

export function mappingUrlOf(source: string): string | null {
  const tail = source.trimEnd().split("\n").pop() ?? "";
  return MAPPING_URL.exec(tail)?.[1] ?? null;
}

export function parseMap(text: string): LoadedMap | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/u, ""));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as { sources?: unknown; mappings?: unknown; sourceRoot?: unknown };
  try {
    const map = new SourceMap({ sources: data.sources, mappings: data.mappings }, 0);
    const root = typeof data.sourceRoot === "string" ? data.sourceRoot : "";
    return { map, sources: map.sources.map((source) => (root && !source.startsWith(root) ? `${root.replace(/\/?$/u, "/")}${source}` : source)) };
  } catch {
    return null;
  }
}

export function inlineMapText(url: string): string | null {
  if (!url.startsWith("data:") || url.length > MAX_INLINE_MAP_BYTES * 2) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const head = url.slice(5, comma);
  const body = url.slice(comma + 1);
  let text: string;
  try {
    text = head.endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
  } catch {
    return null;
  }
  return Buffer.byteLength(text) > MAX_INLINE_MAP_BYTES ? null : text;
}

export function isInlineMap(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith("data:") && url.length <= MAX_INLINE_MAP_BYTES * 2;
}

function remember(cache: Map<string, Cached>, key: string, entry: Cached): void {
  cache.set(key, entry);
  let total = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
  for (const [oldest, item] of cache) {
    if (cache.size <= MAX_CACHED_MAPS && total <= MAX_CACHED_BYTES) break;
    cache.delete(oldest);
    total -= item.bytes;
  }
}

export function mapFor(page: Page, scriptUrl: string, sourceMapUrl: string | null | undefined): LoadedMap | null {
  if (!isInlineMap(sourceMapUrl)) return null;
  let cache = MAPS.get(page);
  if (cache === undefined) {
    cache = new Map();
    MAPS.set(page, cache);
  }
  const key = `${scriptUrl}\n${createHash("sha256").update(sourceMapUrl).digest("hex")}`;
  const known = cache.get(key);
  if (known !== undefined) {
    cache.delete(key);
    cache.set(key, known);
    return known.loaded;
  }
  const text = inlineMapText(sourceMapUrl);
  const loaded = text === null ? null : parseMap(text);
  remember(cache, key, { loaded, bytes: text === null ? 0 : Buffer.byteLength(text) });
  return loaded;
}

export function originalPosition(loaded: LoadedMap, line: number, column: number): Position | null {
  const found = loaded.map.lookup(line, column);
  if (found === null) return null;
  const index = loaded.map.sources.indexOf(found[0]);
  return { url: loaded.sources[index] ?? found[0], line: found[1], column: found[2] };
}

export function sourceMatches(source: string, wanted: string): boolean {
  const clean = (text: string) => text.replace(/^(webpack|vite|file):\/\/\/?[^/]*\/?/u, "").replace(/^\.?\//u, "").replace(/\?.*$/u, "");
  const have = clean(source);
  const want = clean(wanted);
  return have === want || have.endsWith(`/${want}`) || want.endsWith(`/${have}`);
}

function cleanSource(text: string): string {
  return text.replace(/^(webpack|vite|file):\/\/\/?[^/]*\/?/u, "").replace(/^\.?\//u, "").replace(/\?.*$/u, "");
}

export function matchingSource(sources: readonly string[], wanted: string): number {
  const want = cleanSource(wanted);
  const exact = sources.findIndex((source) => cleanSource(source) === want);
  return exact >= 0 ? exact : sources.findIndex((source) => sourceMatches(source, wanted));
}

export function generatedPosition(loaded: LoadedMap, wanted: string, line: number, column: number | null): { line: number; column: number; source: string } | null {
  const index = matchingSource(loaded.sources, wanted);
  if (index < 0) return null;
  let best: { line: number; column: number; distance: number } | null = null;
  loaded.map.lines.forEach((row, generatedLine) => {
    for (const [generatedColumn, source, originalLine, originalColumn] of row) {
      if (source !== index || originalLine !== line - 1) continue;
      const distance = column === null ? originalColumn : Math.abs(originalColumn - (column - 1));
      if (best === null || distance < best.distance) best = { line: generatedLine, column: generatedColumn, distance };
    }
  });
  if (best === null) return null;
  const chosen = best as { line: number; column: number };
  return { line: chosen.line, column: chosen.column, source: loaded.sources[index] as string };
}

export const MAX_SCRIPTS = 5000;

export type BookedScript = { url: string; sourceMapURL: string | null };

export class ScriptBook {
  private readonly scripts = new Map<string, BookedScript>();
  private maps = 0;
  private bytes = 0;

  get size(): number {
    return this.scripts.size;
  }

  get mapBytes(): number {
    return this.bytes;
  }

  get mapCount(): number {
    return this.maps;
  }

  add(id: string, url: string, sourceMapURL: string | null): void {
    this.remove(id);
    const map = isInlineMap(sourceMapURL) ? sourceMapURL : null;
    this.scripts.set(id, { url, sourceMapURL: map });
    if (map !== null) {
      this.maps += 1;
      this.bytes += map.length;
    }
    for (const [oldest, script] of this.scripts) {
      if (this.scripts.size <= MAX_SCRIPTS && this.maps <= MAX_CACHED_MAPS && this.bytes <= MAX_CACHED_BYTES) break;
      if (this.scripts.size > MAX_SCRIPTS) this.remove(oldest);
      else if (script.sourceMapURL !== null) {
        this.maps -= 1;
        this.bytes -= script.sourceMapURL.length;
        this.scripts.set(oldest, { url: script.url, sourceMapURL: null });
      }
    }
  }

  remove(id: string): void {
    const known = this.scripts.get(id);
    if (known === undefined) return;
    this.scripts.delete(id);
    if (known.sourceMapURL !== null) {
      this.maps -= 1;
      this.bytes -= known.sourceMapURL.length;
    }
  }

  clear(): void {
    this.scripts.clear();
    this.maps = 0;
    this.bytes = 0;
  }

  values(): IterableIterator<BookedScript> {
    return this.scripts.values();
  }
}
