import { encodeIdna, nameprep, pointsOf, punycodeDecodes, punycodeEncode, textOf } from "../../src/urlmatch/idna.ts";
import { ipv4, ipv6Compressed, NotAnAddress } from "../../src/urlmatch/ip.ts";
import { SourceMap, vlq } from "../../src/scripts/sourcemap.ts";
import { checkGlob, defaultUrl, manifestEntries, metaDict, parseMeta, rules, slug, urlRuns } from "../../src/scripts/userscript.ts";
import { canonicalHost, decode, globMatches, globPoints, JS, matches, matchPattern, parse, PatternError, split, unescape } from "../../src/urlmatch/urlmatch.ts";

type Twin = (...args: never[]) => unknown;

function metaOf(source: string) {
  return parseMeta(source, "probe.user.ts");
}

function asPatternError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof NotAnAddress) throw new PatternError("not a valid IPv4 address");
    throw error;
  }
}

export const FUNCTIONS: Record<string, Twin> = {
  "urlmatch.decode": (data: number[]) => decode(data),
  "urlmatch.unescape": (data: number[]) => unescape(data),
  "urlmatch.match_pattern": (text: number[], pattern: number[]) => matchPattern(text, pattern),
  "urlmatch.glob_points": (glob: string) => globPoints(glob),
  "urlmatch.ipv4": (host: string) => asPatternError(() => ipv4(host)),
  "urlmatch.canonical_host": (host: string) => canonicalHost(host),
  "urlmatch.parse": (pattern: string) => parse(pattern),
  "urlmatch.split": (url: string) => split(url),
  "urlmatch.js": () => JS,
  "urlmatch.matches": (pattern: string, url: string) => matches(parse(pattern), split(url)),
  "urlmatch.glob_matches": (glob: string, url: string) => globMatches(globPoints(glob), url),
  "idna.encode": (text: string) => encodeIdna(text),
  "idna.nameprep": (text: string) => textOf(nameprep(pointsOf(text))),
  "punycode.decodes": (text: string) => punycodeDecodes(text),
  "punycode.encode": (text: string) => punycodeEncode(pointsOf(text)),
  "ipv6.compressed": (text: string) => ipv6Compressed(text),
  "userscript.parse_meta": (source: string, filename: string) => metaDict(parseMeta(source, filename)),
  "userscript.slug": (name: string) => slug(name),
  "userscript.check_glob": (glob: string, key: string) => checkGlob(glob, key),
  "userscript.rules": (source: string) => rules(metaOf(source)),
  "userscript.url_runs": (source: string, url: string) => urlRuns(metaOf(source), url),
  "userscript.default_url": (source: string) => defaultUrl(metaOf(source)),
  "userscript.manifest_entries": (source: string, js: string) => manifestEntries(metaOf(source), js),
  "userscript.vlq": (segment: string) => vlq(segment),
  "userscript.sourcemap": (data: Record<string, unknown> | null, offset: number, queries: [number, number][]) => {
    const found = new SourceMap(data, offset);
    return queries.map(([line, column]) => found.lookup(line, column));
  },
};
