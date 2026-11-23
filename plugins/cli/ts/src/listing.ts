import type { PythonError } from "./py.ts";
import { recordedSocketCode } from "./error-codes.ts";
import { object, type Value } from "./json.ts";

export type Kind = "tabs" | "groups" | "windows" | "commands";

export function methodOf(kind: Kind): string {
  return kind === "tabs" || kind === "groups" ? "workspace" : kind;
}

export type Listing = {
  dataDir: string | undefined;
  json: boolean;
  window: string | undefined;
  profile: string | undefined;
  flat: boolean;
  usage: boolean;
  pid: bigint | undefined;
};

export function emptyListing(): Listing {
  return { dataDir: undefined, json: false, window: undefined, profile: undefined, flat: false, usage: false, pid: undefined };
}

export function wantsUsage(listing: Listing): boolean {
  return listing.usage || listing.pid !== undefined;
}

export function paramsOf(kind: Kind, listing: Listing): Value | undefined {
  if (kind !== "tabs" && kind !== "groups") return undefined;
  const params = object([]);
  if (listing.window !== undefined && listing.window !== "") params.set("window", listing.window);
  if (listing.profile !== undefined && listing.profile !== "") params.set("profile", listing.profile);
  if (wantsUsage(listing)) params.set("usage", true);
  return params;
}

export type Rendered = { lines: string[]; complaint: string | undefined; status: number; errorCode: string | undefined; crash?: PythonError };

export function rendered(lines: string[] = []): Rendered {
  return { lines, complaint: undefined, status: 0, errorCode: undefined };
}

export function failed(status: number, code: string | undefined, complaint: string, lines: string[] = []): Rendered {
  return { lines, complaint, status, errorCode: code };
}

export function methodFailed(kind: Kind, listing: Listing, code: string, message: string): Rendered {
  if (kind === "windows" || kind === "commands") return failed(1, undefined, `ardia ${kind}: ${message}`);
  if (wantsUsage(listing) && code === "bad_request" && message.includes("not usage")) {
    return failed(1, "unknown_method", `ardia ${kind}: this Ardia doesn't know --usage and --pid yet; update Ardia`);
  }
  if (code === "unknown_method") return failed(1, code, `ardia ${kind}: this Ardia doesn't know ${kind} yet; update Ardia`);
  return failed(1, recordedSocketCode(code), `ardia ${kind}: ${message}`);
}
