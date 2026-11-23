import { readFileSync } from "node:fs";
import { machine, release } from "node:os";
import { LINUX } from "./paths.ts";

export type SystemInfo = { os: string; osType: string; osVersion: string; arch: string };

const MAC_VERSION_PLIST = "/System/Library/CoreServices/SystemVersion.plist";
const PRODUCT_VERSION = /<key>ProductVersion<\/key>\s*<string>([^<]*)<\/string>/;

function macVersion(): string {
  try {
    return PRODUCT_VERSION.exec(readFileSync(MAC_VERSION_PLIST, "utf8"))?.[1] ?? "";
  } catch {
    return "";
  }
}

let cached: SystemInfo | undefined;

export function systemInfo(): SystemInfo {
  if (cached === undefined) {
    cached = {
      os: LINUX ? "Linux" : "macOS",
      osType: LINUX ? "linux" : "darwin",
      osVersion: (LINUX ? "" : macVersion()) || release(),
      arch: machine(),
    };
  }
  return cached;
}
