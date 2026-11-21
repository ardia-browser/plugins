import fs from "node:fs";
import { dumps, parseText, type Value } from "../../json.ts";
import { pythonOsError } from "../../printable.ts";
import { errnoOf, strerror } from "../../paths.ts";
import { reprText } from "../../pylib/str.ts";
import { pyValue } from "../daemon/render.ts";
import { pyError } from "../pyerror.ts";

export function osError(error: unknown, file: string): Error {
  const errno = errnoOf(error);
  if (!errno) return error instanceof Error ? error : new Error(String(error));
  return pyError(pythonOsError(errno), `[Errno ${errno}] ${strerror(errno)}: ${reprText(file)}`);
}

export function readTextPy(file: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw osError(error, file);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw pyError("UnicodeDecodeError", "'utf-8' codec can't decode the file: invalid utf-8");
  }
  return text.replace(/\r\n?/gu, "\n");
}

export function loadsPy(text: string): Value {
  const value = parseText(text);
  if (value === undefined) throw pyError("JSONDecodeError", "Expecting value: line 1 column 1 (char 0)");
  return value;
}

export function writePrivateJson(file: string, value: unknown): void {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  } catch (error) {
    throw osError(error, file);
  }
  try {
    fs.writeSync(fd, dumps(pyValue(value), "indented", true));
  } finally {
    fs.closeSync(fd);
  }
}
