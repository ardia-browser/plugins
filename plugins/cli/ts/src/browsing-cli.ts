import { BrowsingDataError, history, NotRunning, pinned, type Row } from "./browsing.ts";
import { dataRoot } from "./control.ts";
import type { Said } from "./deliver.ts";
import type { Value } from "./json.ts";
import { shown } from "./printable.ts";
import { right, strOf, truthy } from "./py.ts";
import { pretty } from "./render.ts";

export type BrowsingArgs = {
  command: "pinned" | "history";
  json: boolean;
  dataDir: string | undefined;
  days: number;
  limit: bigint;
  profile: string | undefined;
  domains: boolean;
};

function field(value: Value | undefined): string {
  return shown(value === undefined || value === null ? "" : strOf(value));
}

function describePin(row: Row): string {
  const parts = [field(row.get("kind")).padEnd(8), field(truthy(row.get("title")) ? row.get("title") : row.get("url")), field(row.get("url"))];
  if (truthy(row.get("folder"))) parts.push(field(`(folder ${strOf(row.get("folder") as Value)})`));
  parts.push(field(`[${strOf(row.get("profile") as Value)}]${truthy(row.get("parked")) ? " parked" : ""}`));
  return parts.join("  ");
}

function describeVisit(row: Row): string {
  return [
    field(row.get("last_visit")),
    field(right(strOf(row.get("visits") as Value), 4)),
    field(truthy(row.get("title")) ? row.get("title") : "-"),
    field(row.get("url")),
    field(`[${strOf(row.get("profile") as Value)}]`),
  ].join("  ");
}

function describeDomain(row: Row): string {
  const count = row.get("pages") as bigint;
  const pages = `${count} page${count !== 1n ? "s" : ""}`;
  return [
    field(right(strOf(row.get("visits") as Value), 5)),
    field(row.get("domain")),
    field(pages),
    field(truthy(row.get("top_title")) ? row.get("top_title") : "-"),
    field(`[${strOf(row.get("profile") as Value)}]`),
  ].join("  ");
}

export function runBrowsing(args: BrowsingArgs): Said {
  const root = dataRoot(args.dataDir);
  let rows: Row[];
  try {
    if (args.command === "pinned") rows = pinned(root);
    else {
      if (args.days <= 0) return { status: 1, out: [], err: ["ardia history: --days must be more than 0"] };
      if (args.limit < 0n) return { status: 1, out: [], err: ["ardia history: --limit can't be negative"] };
      rows = history(root, { days: args.days, limit: args.limit === 0n ? undefined : Number(args.limit), profile: args.profile, domains: args.domains });
    }
  } catch (error) {
    if (error instanceof NotRunning) return { status: 2, out: [], err: [`ardia: ${error.message}`] };
    if (error instanceof BrowsingDataError) return { status: 1, out: [], err: [`ardia ${args.command}: ${error.message}`] };
    throw error;
  }
  if (args.json) return { status: 0, out: [pretty(rows)], err: [] };
  const describe = args.command === "pinned" ? describePin : args.domains ? describeDomain : describeVisit;
  return { status: 0, out: rows.map(describe), err: [] };
}
