import { describe, expect, test } from "bun:test";
import "./libc-loaded.ts";
import { uploadFiles } from "../src/browse/act/upload.ts";
import { isMutation } from "../src/browse/cdp/browser.ts";
import { BrowseError, Gated } from "../src/browse/daemon-errors.ts";
import { Element, Page } from "../src/browse/state/page.ts";
import type { Json } from "../src/browse/state/records.ts";
import type { State } from "../src/browse/state/state.ts";

type Sent = { method: string; params: Record<string, unknown>; session: string | null | undefined };

function makePage(opts: {
  isInput?: boolean;
  frameSession?: string;
  mainSession?: string;
  onSend?: (method: string, params: Record<string, unknown>, session: string | null | undefined) => void;
}) {
  const sent: Sent[] = [];
  const mainSession = opts.mainSession ?? "S-MAIN";
  const frameSession = opts.frameSession ?? mainSession;
  const state = {
    onPageEvent: () => {},
  } as unknown as State;
  const page = new Page(state, "T1");
  page.sessionId = mainSession;
  page.mainFrame = "F-MAIN";
  if (frameSession !== mainSession) page.frameSessions.set("F-CHILD", frameSession);

  (page as unknown as { call: (...args: unknown[]) => Promise<unknown> }).call = async () => opts.isInput ?? false;
  (page as unknown as { send: (method: string, params?: Record<string, unknown>, options?: { session?: string | null }) => Promise<Record<string, unknown>> }).send =
    async (method, params = {}, options = {}) => {
      sent.push({ method, params, session: options.session });
      opts.onSend?.(method, params, options.session);
      return {};
    };
  return { page, sent };
}

describe("upload file chooser interception", () => {
  test("Page.setInterceptFileChooserDialog is treated as a mutating CDP method", () => {
    expect(isMutation("Page.setInterceptFileChooserDialog")).toBe(true);
  });

  test("direct <input type=file> uses DOM.setFileInputFiles on the element's frame session without enabling interception", async () => {
    const { page, sent } = makePage({ isInput: true, mainSession: "S-MAIN", frameSession: "S-CHILD" });
    const el = new Element("F-CHILD", "obj-1", 42, "#file");

    const outcome = await uploadFiles(page, el, ["/tmp/song.wav"], false);

    expect(outcome).toEqual({ via: "input" });
    expect(sent).toEqual([{ method: "DOM.setFileInputFiles", params: { files: ["/tmp/song.wav"], backendNodeId: 42 }, session: "S-CHILD" }]);
  });

  test("clicking a non-file-input trigger intercepts Page.fileChooserOpened, sets files on the opened input, and turns interception off", async () => {
    const { page, sent } = makePage({ isInput: false });
    const el = new Element("F-MAIN", "obj-btn", 7, 'button "Select an image"');

    const outcome = await uploadFiles(page, el, ["/tmp/cover.jpg"], false, async (p) => {
      p.onEvent("Page.fileChooserOpened", { frameId: "F-MAIN", mode: "selectSingle", backendNodeId: 99 });
    });

    expect(outcome).toEqual({ via: "chooser", mode: "selectSingle" });
    expect(sent).toEqual([
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: true }, session: "S-MAIN" },
      { method: "DOM.setFileInputFiles", params: { files: ["/tmp/cover.jpg"], backendNodeId: 99 }, session: "S-MAIN" },
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: false }, session: "S-MAIN" },
    ]);
    expect(page.fileChooserOpened).toBeNull();
  });

  test("intercepts file choosers opened inside an OOPIF child frame via onChildEvent", async () => {
    const { page, sent } = makePage({ isInput: false, mainSession: "S-MAIN", frameSession: "S-CHILD" });
    const el = new Element("F-CHILD", "obj-btn", 11, "@f1e2");

    const outcome = await uploadFiles(page, el, ["/tmp/a.wav", "/tmp/b.wav"], false, async (p) => {
      p.onChildEvent("S-CHILD", "Page.fileChooserOpened", { frameId: "F-CHILD", mode: "selectMultiple", backendNodeId: 505 });
    });

    expect(outcome).toEqual({ via: "chooser", mode: "selectMultiple" });
    expect(sent).toEqual([
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: true }, session: "S-CHILD" },
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: true }, session: "S-MAIN" },
      { method: "DOM.setFileInputFiles", params: { files: ["/tmp/a.wav", "/tmp/b.wav"], backendNodeId: 505 }, session: "S-CHILD" },
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: false }, session: "S-CHILD" },
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: false }, session: "S-MAIN" },
    ]);
  });

  test("rejects multiple files when the intercepted chooser is selectSingle and still disables interception", async () => {
    const { page, sent } = makePage({ isInput: false });
    const el = new Element("F-MAIN", "obj-btn", 7, "@e1");

    let caught: unknown;
    try {
      await uploadFiles(page, el, ["/tmp/1.wav", "/tmp/2.wav"], false, async (p) => {
        p.onEvent("Page.fileChooserOpened", { frameId: "F-MAIN", mode: "selectSingle", backendNodeId: 99 });
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowseError);
    expect((caught as BrowseError).code).toBe("single_file_only");
    expect(sent.map((item) => [item.method, item.params["enabled"]])).toEqual([
      ["Page.setInterceptFileChooserDialog", true],
      ["Page.setInterceptFileChooserDialog", false],
    ]);
    expect(page.fileChooserOpened).toBeNull();
  });

  test("fails cleanly with no_file_chooser if clicking the target opens no picker, and cleans up interception", async () => {
    const { page, sent } = makePage({ isInput: false });
    const el = new Element("F-MAIN", "obj-btn", 7, "@e3");

    let caught: unknown;
    try {
      await uploadFiles(page, el, ["/tmp/cover.jpg"], false, async () => {}, 0.05);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowseError);
    expect((caught as BrowseError).code).toBe("no_file_chooser");
    expect(sent.map((item) => [item.method, item.params["enabled"]])).toEqual([
      ["Page.setInterceptFileChooserDialog", true],
      ["Page.setInterceptFileChooserDialog", false],
    ]);
    expect(page.fileChooserOpened).toBeNull();
  });

  test("fails cleanly with unsupported_file_chooser if backendNodeId is absent", async () => {
    const { page, sent } = makePage({ isInput: false });
    const el = new Element("F-MAIN", "obj-btn", 7, "@e4");

    let caught: unknown;
    try {
      await uploadFiles(page, el, ["/tmp/cover.jpg"], false, async (p) => {
        p.onEvent("Page.fileChooserOpened", { frameId: "F-MAIN", mode: "selectSingle" } as Json);
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowseError);
    expect((caught as BrowseError).code).toBe("unsupported_file_chooser");
    expect(sent.at(-1)).toEqual({ method: "Page.setInterceptFileChooserDialog", params: { enabled: false }, session: "S-MAIN" });
  });

  test("turns a Gated refusal on Page.setInterceptFileChooserDialog into the upload policy_refused message", async () => {
    const { page } = makePage({
      isInput: false,
      onSend: (method) => {
        if (method === "Page.setInterceptFileChooserDialog") throw new Gated(method);
      },
    });
    const el = new Element("F-MAIN", "obj-btn", 7, "@e5");

    let caught: unknown;
    try {
      await uploadFiles(page, el, ["/tmp/cover.jpg"], false);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Gated);
    expect((caught as Gated).code).toBe("policy_refused");
    expect((caught as Gated).text).toContain("`upload` needs Ardia 0.2.49 or later");
  });

  test("disables interception in finally even when the click throws", async () => {
    const { page, sent } = makePage({ isInput: false });
    const el = new Element("F-MAIN", "obj-btn", 7, "@e6");

    let caught: unknown;
    try {
      await uploadFiles(page, el, ["/tmp/cover.jpg"], false, async () => {
        throw new BrowseError("Element obstructed", null, "obstructed");
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as BrowseError).code).toBe("obstructed");
    expect(sent).toEqual([
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: true }, session: "S-MAIN" },
      { method: "Page.setInterceptFileChooserDialog", params: { enabled: false }, session: "S-MAIN" },
    ]);
    expect(page.fileChooserOpened).toBeNull();
  });
});
