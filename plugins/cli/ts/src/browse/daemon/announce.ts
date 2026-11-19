import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { peerUid } from "../../libc.ts";
import { uid } from "../../paths.ts";

export const ANNOUNCE_TIMEOUT = 1.0;
export const SOCKET_FILE = "ArdiaControl.sock";
export const PROTOCOL = 4;
const MAX_NAME = 40;
const MAX_APP_PATH = 1024;
const SUN_PATH_MAX = 104;
const MAX_LINE = 1024 * 1024;

export type Caller = { readonly name: string; readonly app: string | null };

export function cleanName(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let kept = "";
  for (const char of text) {
    if (/\p{White_Space}/u.test(char) || /\p{Z}/u.test(char)) kept += " ";
    else if (!/\p{C}/u.test(char)) kept += char;
  }
  const joined = kept.split(/\s+/u).filter((part) => part !== "").join(" ");
  const name = [...joined].slice(0, MAX_NAME).join("").trim();
  return name || null;
}

export function outerBundle(file: string): string | null {
  const parts = file.split("/").filter((part, index) => part !== "" || index === 0);
  const named = parts[0] === "" ? ["/", ...parts.slice(1)] : parts;
  for (let index = 0; index < named.length - 1; index += 1) {
    const part = named[index] as string;
    if (part.endsWith(".app") && part.length > 4 && named[index + 1] === "Contents") {
      const kept = named.slice(0, index + 1);
      return kept[0] === "/" ? `/${kept.slice(1).join("/")}` : kept.join("/");
    }
  }
  return null;
}

export function parseCaller(raw: unknown): Caller | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const name = cleanName(fields["name"]);
  if (name === null) return null;
  const app = fields["app"];
  const usable = typeof app === "string" && [...app].length <= MAX_APP_PATH && app.startsWith("/") && !app.split("/").includes("..");
  return { name, app: usable && outerBundle(`${app}/Contents/MacOS`) === app ? app : null };
}

export function sameCaller(a: Caller | null, b: Caller | null): boolean {
  return a !== null && b !== null && a.name === b.name && a.app === b.app;
}

export function wire(caller: Caller): Record<string, string> {
  return caller.app ? { name: caller.name, app: caller.app } : { name: caller.name };
}

export function announcePath(controlFile: string): string {
  return path.join(path.dirname(path.dirname(controlFile)), SOCKET_FILE);
}

function usableSocket(file: string): boolean {
  if (Buffer.byteLength(file) > SUN_PATH_MAX) return false;
  try {
    const info = fs.lstatSync(file);
    return info.isSocket() && info.uid === uid();
  } catch {
    return false;
  }
}

export function announce(file: string, caller: Caller, timeout = ANNOUNCE_TIMEOUT): Promise<void> {
  if (!usableSocket(file)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const socket = net.connect(file);
    let buffer = "";
    let stage = 0;
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(done, timeout * 1000);
    socket.on("error", done);
    socket.on("close", done);
    socket.once("connect", () => {
      const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
      let peer: number | null = null;
      try {
        peer = typeof fd === "number" ? peerUid(fd) : null;
      } catch {}
      if (peer !== uid()) {
        done();
        return;
      }
      socket.write(`${JSON.stringify({ id: 1, method: "hello", params: { caller: wire(caller), protocol: PROTOCOL } })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE) {
        done();
        return;
      }
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(line) as Record<string, unknown>;
        } catch {
          done();
          return;
        }
        if (stage === 0 && reply["id"] === 1) {
          const info = reply["result"] as Record<string, unknown> | undefined;
          if (info?.["app"] !== "Ardia") {
            done();
            return;
          }
          stage = 1;
          socket.write(`${JSON.stringify({ id: 2, method: "caller" })}\n`);
        } else if (stage === 1 && reply["id"] === 2) {
          done();
          return;
        }
      }
    });
  });
}
