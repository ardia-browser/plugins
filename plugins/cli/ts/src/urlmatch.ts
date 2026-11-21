import { NeedsPython } from "./paths.ts";

export class PatternError extends Error {}

export type Spec = { readonly pattern: string };
export type UrlParts = { readonly url: string };

export function parse(pattern: string): Spec {
  throw new NeedsPython(`match pattern ${pattern} needs the URL matcher`);
}

export function split(url: string): UrlParts | null {
  throw new NeedsPython(`matching ${url.length}-character URLs needs the URL matcher`);
}

export function matches(_spec: Spec, _url: UrlParts | null): boolean {
  throw new NeedsPython("matching URLs needs the URL matcher");
}
