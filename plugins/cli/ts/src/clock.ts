export function now(): number {
  return (performance.timeOrigin + performance.now()) / 1000;
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export function civil(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = floorDiv(z, 146_097);
  const doe = mod(z, 146_097);
  const yoe = Math.trunc((doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const day = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

export function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = floorDiv(shifted, 400);
  const yoe = mod(shifted, 400);
  const doy = Math.trunc((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

const two = (value: number) => String(value).padStart(2, "0");
const four = (value: number) => String(value).padStart(4, "0");

export function utcDay(seconds: number): string {
  const [year, month, day] = civil(floorDiv(Math.floor(seconds), 86_400));
  return `${four(year)}-${two(month)}-${two(day)}`;
}

export function iso(seconds: number): string {
  const whole = Math.floor(seconds);
  const [year, month, day] = civil(floorDiv(whole, 86_400));
  const rest = mod(whole, 86_400);
  const millis = mod(Math.trunc(seconds * 1000), 1000);
  const clock = `${two(Math.trunc(rest / 3600))}:${two(Math.trunc((rest % 3600) / 60))}:${two(rest % 60)}`;
  return `${four(year)}-${two(month)}-${two(day)}T${clock}.${String(millis).padStart(3, "0")}Z`;
}

function digits(text: string | undefined, count: number): number | undefined {
  return text !== undefined && text.length === count && /^[0-9]+$/.test(text) ? Number.parseInt(text, 10) : undefined;
}

function localSeconds(utc: number): number {
  const at = new Date(utc * 1000);
  const asUtc = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds());
  const shifted = new Date(asUtc);
  if (at.getFullYear() < 100) shifted.setUTCFullYear(at.getFullYear());
  return shifted.getTime() / 1000;
}

export function naiveToUtc(t: number, local: (utc: number) => number = localSeconds): number {
  const a = local(t) - t;
  const u1 = t - a;
  const t1 = local(u1);
  let b: number;
  if (t1 === t) {
    const earlier = u1 - 86_400;
    b = local(earlier) - earlier;
    if (a === b) return u1;
  } else b = t1 - u1;
  const u2 = t - b;
  if (local(u2) === t) return u2;
  if (t1 === t) return u1;
  return Math.max(u1, u2);
}

export type Iso = { at: number } | "invalid" | "unported";

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function clockOf(text: string): number | undefined {
  const separated = text[2] === ":";
  let at = 0;
  const parts = [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (index > 0) {
      if (at >= text.length || text[at] === "." || text[at] === ",") break;
      if (separated) {
        if (text[at] !== ":") return undefined;
        at += 1;
      }
    }
    const part = digits(text.slice(at, at + 2), 2);
    if (part === undefined || at + 2 > text.length) return undefined;
    parts[index] = part;
    at += 2;
  }
  let fraction = 0;
  if (at < text.length) {
    if (text[at] !== "." && text[at] !== ",") return undefined;
    const rest = text.slice(at + 1);
    if (rest === "" || !/^[0-9]+$/.test(rest)) return undefined;
    const kept = rest.slice(0, 6);
    fraction = Number.parseFloat(kept) / 10 ** kept.length;
  }
  const [hour = 0, minute = 0, second = 0] = parts;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return hour * 3600 + minute * 60 + second + fraction;
}

export function parseIso(text: string): Iso {
  return parseIsoAt(text.replaceAll("Z", "+00:00")) ?? "invalid";
}

function weekday(days: number): number {
  return (((days + 3) % 7) + 7) % 7;
}

function longIsoYear(year: number): boolean {
  const first = weekday(daysFromCivil(year, 1, 1));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return first === 3 || (leap && first === 2);
}

function weekDate(bytes: string, extended: boolean): [number, number] | undefined {
  const year = digits(bytes.slice(0, 4), 4);
  let at = extended ? 6 : 5;
  const week = digits(bytes.slice(at, at + 2), 2);
  at += 2;
  if (year === undefined || week === undefined || year < 1) return undefined;
  let day = 1;
  const more = bytes[at];
  if (more !== undefined && more !== "T" && more !== " " && more !== "+") {
    if ((more === "-") !== extended) return undefined;
    if (extended) at += 1;
    const given = digits(bytes.slice(at, at + 1), 1);
    if (given === undefined) return undefined;
    day = given;
    at += 1;
  }
  if (week < 1 || week > (longIsoYear(year) ? 53 : 52) || day < 1 || day > 7) return undefined;
  const fourth = daysFromCivil(year, 1, 4);
  const days = fourth - weekday(fourth) + (week - 1) * 7 + (day - 1);
  return [at, days * 86_400];
}

function parseIsoAt(text: string): Iso | undefined {
  const bytes = Buffer.from(text, "utf8").toString("latin1");
  const extended = bytes[4] === "-";
  let prefix: number;
  let base: number;
  if (bytes[extended ? 5 : 4] === "W") {
    const week = weekDate(bytes, extended);
    if (week === undefined) return undefined;
    [prefix, base] = week;
  } else {
    if (extended && bytes[7] !== "-") return undefined;
    prefix = extended ? 10 : 8;
    if (bytes.length < prefix) return undefined;
    const [year, month, day] = extended
      ? [digits(bytes.slice(0, 4), 4), digits(bytes.slice(5, 7), 2), digits(bytes.slice(8, 10), 2)]
      : [digits(bytes.slice(0, 4), 4), digits(bytes.slice(4, 6), 2), digits(bytes.slice(6, 8), 2)];
    if (year === undefined || month === undefined || day === undefined) return undefined;
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
    base = daysFromCivil(year, month, day) * 86_400;
  }
  const rest = text.slice(prefix);
  const chars = [...rest];
  if (chars.length === 0) return { at: naiveToUtc(base) };
  const time = chars.slice(1).join("");
  const plus = time.indexOf("+");
  const minus = time.indexOf("-");
  const found = [plus, minus].filter((index) => index >= 0);
  const zoneAt = found.length > 0 ? Math.min(...found) : undefined;
  const clock = clockOf(time.slice(0, zoneAt ?? time.length));
  if (clock === undefined) return undefined;
  if (zoneAt === undefined) {
    const whole = Math.floor(clock);
    return { at: naiveToUtc(base + whole) + (clock - whole) };
  }
  const sign = time[zoneAt] === "-" ? -1 : 1;
  const offset = clockOf(time.slice(zoneAt + 1));
  if (offset === undefined) return undefined;
  return { at: base + clock - sign * offset };
}
