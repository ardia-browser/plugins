import { isSpace, strip } from "../py.ts";
import { codePoints } from "../pystr.ts";
import { zeroPad } from "../pylib/format.ts";
import { DigitPattern } from "../pylib/re.ts";
import { pyFloatOrUndefined, reprText } from "../pylib/str.ts";
import { FIELDS_SET_VALUE } from "./js/index.ts";
import { BrowseError } from "./daemon-errors.ts";

export const SET_DIRECTLY = new Set(["date", "time", "datetime-local", "month", "week", "color", "range"]);
export const FORMATS: Readonly<Record<string, string>> = {
  date: "a date input takes YYYY-MM-DD, like 2026-11-09",
  time: "a time input takes HH:MM in 24-hour time (optionally :SS), like 14:30, or 2:30 PM",
  "datetime-local": "a datetime-local input takes YYYY-MM-DDTHH:MM, like 2026-11-09T14:30",
  month: "a month input takes YYYY-MM, like 2026-11",
  week: "a week input takes YYYY-Www, like 2026-W46",
  color: "a color input takes #rrggbb, like #3b82f6",
  range: "a range input takes a number, like 50",
};
const DATE = new DigitPattern("(\\d{4,6})-(\\d{1,2})-(\\d{1,2})");
const TIME = new DigitPattern("(\\d{1,2})(?::(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?)?\\s*([ap]\\.?m\\.?)?", "i");
const MONTH = new DigitPattern("(\\d{4,6})-(\\d{1,2})");
const WEEK = new DigitPattern("(\\d{4,6})-?[wW](\\d{1,2})");
const COLOR = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
export const SET_VALUE = FIELDS_SET_VALUE;

function refuse(kind: string, text: string): never {
  throw new BrowseError(`${reprText(text)} isn't a ${kind} value: ${FORMATS[kind]}`, { type: kind }, "bad_value");
}

function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function datePart(kind: string, text: string, value: string): string {
  const match = DATE.fullmatch(value);
  if (!match) refuse(kind, text);
  const [year, month, day] = match.digits.map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) refuse(kind, text);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) refuse(kind, text);
  return `${zeroPad(year, 4)}-${zeroPad(month, 2)}-${zeroPad(day, 2)}`;
}

function timePart(kind: string, text: string, value: string): string {
  const match = TIME.fullmatch(strip(value, isSpace));
  if (!match || (match.groups[1] === undefined && !match.groups[4])) refuse(kind, text);
  const [hourText, minuteText, second, , meridiem] = match.digits;
  const fraction = match.groups[3];
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (meridiem) {
    if (!(hour >= 1 && hour <= 12)) refuse(kind, text);
    hour = (hour % 12) + (meridiem.toLowerCase().startsWith("p") ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || (second !== undefined && Number(second) > 59)) refuse(kind, text);
  let out = `${zeroPad(hour, 2)}:${zeroPad(minute, 2)}`;
  if (second !== undefined) {
    out += `:${zeroPad(Number(second), 2)}`;
    if (fraction !== undefined) out += `.${fraction}`;
  }
  return out;
}

function splitOnce(value: string): string[] {
  const at = value.search(/[Tt ]/);
  return at < 0 ? [value] : [value.slice(0, at), value.slice(at + 1)];
}

export function normalize(kind: string, text: string): string {
  const value = strip(text, isSpace);
  if (value === "") return "";
  if (kind === "date") return datePart(kind, text, value);
  if (kind === "time") return timePart(kind, text, value);
  if (kind === "datetime-local") {
    const parts = splitOnce(value);
    if (parts.length !== 2) refuse(kind, text);
    return `${datePart(kind, text, parts[0] as string)}T${timePart(kind, text, parts[1] as string)}`;
  }
  if (kind === "month") {
    const match = MONTH.fullmatch(value);
    if (!match || !(Number(match.digits[1]) >= 1 && Number(match.digits[1]) <= 12)) refuse(kind, text);
    return `${zeroPad(Number(match.digits[0]), 4)}-${zeroPad(Number(match.digits[1]), 2)}`;
  }
  if (kind === "week") {
    const match = WEEK.fullmatch(value);
    if (!match || !(Number(match.digits[1]) >= 1 && Number(match.digits[1]) <= 53)) refuse(kind, text);
    return `${zeroPad(Number(match.digits[0]), 4)}-W${zeroPad(Number(match.digits[1]), 2)}`;
  }
  if (kind === "color") {
    const match = COLOR.exec(value);
    if (!match) refuse(kind, text);
    const digits = (match[1] as string).toLowerCase();
    return `#${digits.length === 6 ? digits : codePoints(digits).map((char) => char + char).join("")}`;
  }
  if (kind === "range") {
    const number = pyFloatOrUndefined(value);
    if (number === undefined || !Number.isFinite(number)) refuse(kind, text);
    return value;
  }
  throw new BrowseError(`${kind} inputs aren't set directly`);
}
