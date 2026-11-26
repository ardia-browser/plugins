import { shield } from "../cdp/cancel.ts";
import { TimedOut, within } from "../changes/observe.ts";
import { BrowseError, Gated } from "../daemon-errors.ts";
import type { Element, Page } from "../state/page.ts";
import type { Json } from "../state/records.ts";
import { CLEANUP_TIMEOUT, click } from "./pointer.ts";

export const FILE_CHOOSER_TIMEOUT = 3.0;

export type UploadOutcome = { via: "input" | "chooser"; mode?: string };
type ChooserEvent = { params: Json; session: string | null };

const IS_FILE_INPUT = "(el) => Boolean(el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file')";

export async function isFileInput(page: Page, element: Element): Promise<boolean> {
  try {
    return Boolean(await page.call(IS_FILE_INPUT, [element], { frame: element.frame, read: true }));
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
}

async function sendFiles(page: Page, files: string[], backendNodeId: number, session: string | null): Promise<void> {
  try {
    await page.send("DOM.setFileInputFiles", { files, backendNodeId }, { session });
  } catch (error) {
    if (error instanceof Gated) throw error.during("upload");
    throw error;
  }
}

function uniqueSessions(page: Page, frame: string): (string | null)[] {
  const frameSession = page.sessionFor(frame);
  const mainSession = page.session;
  return frameSession === mainSession ? [frameSession] : [frameSession, mainSession];
}

export async function uploadFiles(
  page: Page,
  element: Element,
  files: string[],
  humanize: boolean,
  trigger: (page: Page, element: Element, humanize: boolean) => Promise<void> = (p, el, h) => click(p, el, h),
  timeoutSeconds = FILE_CHOOSER_TIMEOUT,
): Promise<UploadOutcome> {
  if (await isFileInput(page, element)) {
    await sendFiles(page, files, element.backendId, page.sessionFor(element.frame));
    return { via: "input" };
  }

  const sessions = uniqueSessions(page, element.frame);
  const enabled: (string | null)[] = [];
  let resolveChooser: ((event: ChooserEvent) => void) | null = null;
  const chooserPromise = new Promise<ChooserEvent>((resolve) => {
    resolveChooser = resolve;
  });

  try {
    for (const session of sessions) {
      try {
        await page.send("Page.setInterceptFileChooserDialog", { enabled: true }, { session });
        enabled.push(session);
      } catch (error) {
        if (error instanceof Gated) throw error.during("upload");
        throw error;
      }
    }

    page.fileChooserOpened = (params, session) => {
      resolveChooser?.({ params, session });
    };

    await trigger(page, element, humanize);

    let chooser: ChooserEvent;
    try {
      chooser = await within(chooserPromise, timeoutSeconds);
    } catch (error) {
      if (error instanceof TimedOut) {
        throw new BrowseError(
          `Clicking ${element.label} didn't open a file chooser. Pass the <input type="file"> selector directly or click the control that opens the file picker`,
          null,
          "no_file_chooser",
        );
      }
      throw error;
    }

    const mode = typeof chooser.params["mode"] === "string" ? chooser.params["mode"] : undefined;
    if (mode === "selectSingle" && files.length > 1) {
      throw new BrowseError(`That file picker accepts only one file, but ${files.length} were given`, { mode, count: files.length }, "single_file_only");
    }

    const backendNodeId = chooser.params["backendNodeId"];
    if (typeof backendNodeId !== "number") {
      throw new BrowseError(
        "The page opened a file picker without a file input element, so `ardia browse upload` can't attach files to it",
        null,
        "unsupported_file_chooser",
      );
    }

    const frameId = typeof chooser.params["frameId"] === "string" ? chooser.params["frameId"] : null;
    const targetSession = (frameId ? page.sessionFor(frameId) : null) ?? chooser.session ?? page.sessionFor(element.frame);
    await sendFiles(page, files, backendNodeId, targetSession);
    return mode ? { via: "chooser", mode } : { via: "chooser" };
  } finally {
    page.fileChooserOpened = null;
    await Promise.all(
      enabled.map((session) =>
        shield(() =>
          page.send("Page.setInterceptFileChooserDialog", { enabled: false }, { session, timeout: CLEANUP_TIMEOUT }).catch(() => {}),
        ).catch(() => {}),
      ),
    );
  }
}
