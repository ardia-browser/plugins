import { type GroupChild, spawnGroup } from "../../proc/group.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pyStrip } from "../../pylib/str.ts";
import { untilCancelled } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";
import { PDFTEXT_FETCH, PDFTEXT_JXA } from "../js/index.ts";
import { flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";
import { quiet } from "../state/page.ts";
import { record } from "../state/records.ts";

export const MAX_BYTES = 40 * 1024 * 1024;
export const EXTRACT_TIMEOUT = 120;
export const NO_TEXT = "(this PDF has no text layer, so it is probably scanned pages; look at it with `ardia browse screenshot`)";
export const tools = { osascript: "osascript" };

export function isPdfType(kind: unknown): boolean {
  return pyStrip(String(kind ?? "").split(";")[0] as string).toLowerCase() === "application/pdf";
}

export async function pageIsPdf(page: Page, frame: string | null = null): Promise<boolean> {
  try {
    return isPdfType(await page.call("() => document.contentType", [], { frame: frame || page.mainFrame, read: true }));
  } catch (error) {
    if (quiet(error)) return false;
    throw error;
  }
}

function startsPdf(data: Uint8Array): boolean {
  return data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
}

function run(file: string): { done: Promise<[string, number]>; kill: () => void } {
  const started = spawnGroup([tools.osascript, "-l", "JavaScript", "-e", PDFTEXT_JXA, file], { stdout: "pipe" });
  let group: GroupChild | null = null;
  let killed = false;
  const done = started.then((child) => {
    group = child;
    if (killed) child.signal("SIGKILL");
    const chunks: Buffer[] = [];
    child.child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    return child.closed.then((code): [string, number] => {
      child.forget();
      return [new TextDecoder("utf-8").decode(Buffer.concat(chunks)).replace(/\r\n?/gu, "\n"), code < 0 ? 1 : code];
    });
  });
  return {
    done,
    kill: () => {
      killed = true;
      (group as GroupChild | null)?.signal("SIGKILL");
    },
  };
}

export async function textFromBytes(data: Uint8Array): Promise<string> {
  if (!startsPdf(data)) throw new BrowseError("the document said it was a PDF but isn't one", null, "pdf_unreadable");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-pdf-"));
  let status: number;
  let stdout: string;
  try {
    const file = path.join(folder, "document.pdf");
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    const child = run(file);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, EXTRACT_TIMEOUT * 1000);
    try {
      [stdout, status] = await untilCancelled(child.done);
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new BrowseError(`reading the PDF's text took over ${EXTRACT_TIMEOUT} s`, null, "pdf_unreadable");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  if (status || stdout.startsWith("\0")) throw new BrowseError("macOS couldn't open the PDF to read its text", null, "pdf_unreadable");
  const pages = stdout.replace(/\n+$/u, "").split("\f");
  const text = pages
    .map((page, index) => [index + 1, page] as const)
    .filter(([, page]) => pyStrip(page))
    .map(([number, page]) => `[page ${number} of ${pages.length}]\n${pyStrip(page)}`)
    .join("\n\n");
  return text || NO_TEXT;
}

export async function pageText(page: Page): Promise<string> {
  const got = record(await page.call(PDFTEXT_FETCH, [MAX_BYTES], { frame: page.mainFrame, read: true, timeout: EXTRACT_TIMEOUT }));
  if (got["error"]) throw new BrowseError(`couldn't fetch the PDF to read it: ${got["error"]}`, null, "pdf_unreadable");
  flag("read_pdf", true);
  return textFromBytes(Buffer.from(String(got["data"] ?? ""), "base64"));
}
