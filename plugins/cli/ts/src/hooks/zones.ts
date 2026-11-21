import { closeSync, openSync, readSync, statSync } from "node:fs";
import { normpath } from "../paths.ts";

const DEFAULT_TZPATH = ["/usr/share/zoneinfo", "/usr/lib/zoneinfo", "/usr/share/lib/zoneinfo", "/etc/zoneinfo"];
const HEADER_BYTES = 44;
const FOLD_SECONDS = 24 * 3600;

function tzPath(): string[] {
  const given = process.env.PYTHONTZPATH;
  if (given === undefined) return DEFAULT_TZPATH;
  return given.split(":").filter((entry) => entry.startsWith("/"));
}

function validKey(key: string): boolean {
  if (key.startsWith("/") || key.includes("\0")) return false;
  const root = normpath(key);
  if (root.length !== key.length) return false;
  return !normpath(`/_/${root}`).startsWith("/_/..") && normpath(`/_/${root}`).startsWith("/_");
}

function isTzif(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(HEADER_BYTES);
    const count = readSync(fd, header, 0, HEADER_BYTES, 0);
    return count === HEADER_BYTES && header.subarray(0, 4).toString("latin1") === "TZif";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function knownZone(key: string): boolean {
  if (!validKey(key)) return false;
  for (const folder of tzPath()) {
    const path = `${folder}/${key}`;
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    return isTzif(path);
  }
  return false;
}

export type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(zone, found);
  }
  return found;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function wallAt(seconds: number, zone: string | null): Wall {
  const date = new Date(Math.floor(seconds) * 1000);
  if (zone === null) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: (date.getDay() + 6) % 7,
    };
  }
  const parts = new Map(formatter(zone).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    second: Number(parts.get("second")),
    weekday: WEEKDAYS.indexOf(parts.get("weekday") ?? ""),
  };
}

function wallSeconds(wall: { year: number; month: number; day: number; hour: number; minute: number; second: number }): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) / 1000;
}

export function epochOf(wall: { year: number; month: number; day: number; hour: number; minute: number; second?: number }, zone: string | null): number {
  const t = wallSeconds({ ...wall, second: wall.second ?? 0 });
  const local = (u: number) => wallSeconds(wallAt(u, zone));
  const a = local(t) - t;
  const u1 = t - a;
  const t1 = local(u1);
  let b: number;
  if (t1 === t) {
    const u2 = u1 - FOLD_SECONDS;
    b = local(u2) - u2;
    if (a === b) return u1;
  } else b = t1 - u1;
  const u2 = t - b;
  const t2 = local(u2);
  if (t2 === t) return u2;
  if (t1 === t) return u1;
  return Math.max(u1, u2);
}

export function addDays(wall: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number; weekday: number } {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: (date.getUTCDay() + 6) % 7 };
}
