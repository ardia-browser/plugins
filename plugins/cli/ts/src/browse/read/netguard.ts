import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { BrowseError } from "../daemon-errors.ts";

export type Resolver = (host: string) => Promise<string[]>;
export type PinnedInit = { headers: Record<string, string>; signal: AbortSignal; ca?: string[] | null };
export type Pinned = { url: string; address: string };
export type HopGuard = { check(url: string): Promise<Pinned | null>; request(pinned: Pinned, init: PinnedInit): Promise<Response> };

export class UnsafeAddress extends BrowseError {
  constructor(url: string) {
    super(`Didn't fetch ${url}: it's on a private, local or link-local address the page doesn't share an origin with`, null, "unsafe_address");
  }
}

const V4_BLOCKS: readonly [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Number(ip: string): number {
  return ip.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

function v4Private(ip: string): boolean {
  const value = v4Number(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4Number(base);
    return value >= start && value < start + size;
  });
}

function v6Groups(ip: string): number[] | null {
  const text = ip.toLowerCase();
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").map((part) => parseInt(part, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((part) => parseInt(part, 16)) : [];
  const fill = 8 - left.length - right.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0) return null;
  const groups = [...left, ...Array(fill).fill(0), ...right];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

export function privateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/gu, "").split("%")[0] as string;
  if (net.isIPv4(ip)) return v4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(ip);
  if (embedded) {
    const prefix = (embedded[1] as string).toLowerCase();
    return ["::", "::ffff:", "64:ff9b::", "::ffff:0:"].includes(prefix) ? v4Private(embedded[2] as string) : true;
  }
  const groups = v6Groups(ip);
  if (groups === null) return true;
  const first = groups[0] as number;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const nat64 = first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (mapped || nat64) {
    const high = groups[6] as number;
    const low = groups[7] as number;
    return v4Private([high >> 8, high & 255, low >> 8, low & 255].join("."));
  }
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00 || (first === 0x2001 && groups[1] === 0x0db8)) return true;
  return false;
}

export const dnsResolve: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function localName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".");
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
}

export function hopGuard(base: string, resolve: Resolver = dnsResolve): HopGuard {
  const home = originOf(base);
  const homeHost = home === null ? "" : hostOf(base);
  let homeLocal: boolean | null = home === null ? false : net.isIP(homeHost) ? privateAddress(homeHost) : localName(homeHost) ? true : null;
  const pick = async (url: string): Promise<string | null> => {
    const host = hostOf(url);
    const atHome = originOf(url) === home;
    if (net.isIP(host)) return atHome || !privateAddress(host) ? host : null;
    if (!atHome && localName(host)) return null;
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      return null;
    }
    if (addresses.length === 0) return null;
    const allPublic = addresses.every((address) => !privateAddress(address));
    if (atHome) {
      if (homeLocal === null) homeLocal = !allPublic;
      if (homeLocal) return addresses[0] as string;
    }
    return allPublic ? (addresses[0] as string) : null;
  };
  const check = async (url: string): Promise<Pinned | null> => {
    if (originOf(url) === null) return null;
    const address = await pick(url);
    return address === null ? null : { url, address };
  };
  const request = (pinned: Pinned, init: PinnedInit): Promise<Response> =>
    new Promise((resolveResponse, reject) => {
      const url = pinned.url;
      const parsed = new URL(url);
      const host = hostOf(url);
      const lookupPinned = (_name: string, options: unknown, callback: (...args: unknown[]) => void) => {
        const address = pinned.address;
        const family = net.isIPv6(address) ? 6 : 4;
        if (options && typeof options === "object" && (options as { all?: boolean }).all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      };
      const transport = parsed.protocol === "https:" ? https : http;
      const options: Record<string, unknown> = { method: "GET", headers: init.headers, lookup: lookupPinned, signal: init.signal };
      if (parsed.protocol === "https:") {
        options["servername"] = net.isIP(host) ? undefined : host;
        if (init.ca) options["ca"] = init.ca;
      }
      const outgoing = transport.request(url, options, (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        }
        const status = incoming.statusCode ?? 502;
        const body = status === 204 || status === 304 ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
        try {
          resolveResponse(new Response(body, { status: status < 200 || status > 599 ? 502 : status, headers }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      outgoing.on("error", (error: unknown) => reject(error));
      outgoing.end();
    });
  return { check, request };
}
