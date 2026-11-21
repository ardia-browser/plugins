import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, type Launch } from "./cdp";
import { centroid, decodePng } from "./png";
import { Tab, type Mode, type Point } from "./tab";

export type RowContext = { launch: Launch; cdp: Cdp; base: string; mode: Mode; scratch: string; browserContextId?: string; notes: Record<string, unknown>; baselines: Record<string, unknown> };

export type Row = {
  row: number;
  page: string;
  modes: Mode[];
  headed?: boolean;
  host?: string;
  open?: (context: RowContext) => Promise<Tab>;
  before?: (tab: Tab, context: RowContext) => Promise<void>;
  act: (tab: Tab, context: RowContext) => Promise<void>;
};

const sleep = (ms: number) => Bun.sleep(ms);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const pageUrl = (context: RowContext, page: string) => `${context.base}/${page}`;
const isMac = process.platform === "darwin";
const commandKey = isMac ? "meta" : "ctrl";

async function walkDom(tab: Tab) {
  const { root } = await tab.send("DOM.getDocument", { depth: -1, pierce: true });
  const nodes: any[] = [];
  const visit = (node: any, shadow: string | null) => {
    nodes.push({ ...node, inShadow: shadow });
    for (const child of node.children ?? []) visit(child, shadow);
    for (const rootNode of node.shadowRoots ?? []) visit(rootNode, rootNode.shadowRootType);
    if (node.contentDocument) visit(node.contentDocument, shadow);
  };
  visit(root, null);
  return nodes;
}

const attribute = (node: any, name: string) => {
  const list: string[] = node.attributes ?? [];
  const index = list.indexOf(name);
  return index >= 0 && index % 2 === 0 ? list[index + 1] : undefined;
};

async function nodeCenter(tab: Tab, nodeId: number): Promise<Point> {
  const { model } = await tab.send("DOM.getBoxModel", { nodeId });
  const quad: number[] = model.content;
  return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
}

async function nodeText(tab: Tab, nodeId: number) {
  const executionContextId = await tab.isolatedContext();
  const { object } = await tab.send("DOM.resolveNode", { nodeId, executionContextId });
  const { result } = await tab.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function() { return this.textContent; }", returnByValue: true });
  return result.value as string;
}

async function humanPath(tab: Tab, from: Point, to: Point, steps: number, intervalMs: number) {
  const bend = { x: (from.x + to.x) / 2 + (Math.random() - 0.5) * 120, y: (from.y + to.y) / 2 + (Math.random() - 0.5) * 120 };
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = (1 - eased) ** 2 * from.x + 2 * (1 - eased) * eased * bend.x + eased ** 2 * to.x + (step < steps ? (Math.random() - 0.5) * 2 : 0);
    const y = (1 - eased) ** 2 * from.y + 2 * (1 - eased) * eased * bend.y + eased ** 2 * to.y + (step < steps ? (Math.random() - 0.5) * 2 : 0);
    await tab.move({ x, y });
    await sleep(intervalMs + Math.random() * 4);
  }
}

async function frameContexts(cdp: Cdp, sessions: string[]) {
  const found: Record<string, { session: string; contextId: number }> = {};
  for (const session of sessions) {
    const { frameTree } = await cdp.send("Page.getFrameTree", {}, session);
    const frames: any[] = [];
    const visit = (node: any) => { frames.push(node.frame); for (const child of node.childFrames ?? []) visit(child); };
    visit(frameTree);
    for (const frame of frames) {
      try {
        const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "ardia-human" }, session);
        const { result } = await cdp.send("Runtime.evaluate", { expression: "new URLSearchParams(location.search).get('role') || 'top'", contextId: executionContextId, returnByValue: true }, session);
        if (!found[result.value]) found[result.value] = { session, contextId: executionContextId };
      } catch {}
    }
  }
  return found;
}

async function isoIn(cdp: Cdp, place: { session: string; contextId: number }, expression: string) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, contextId: place.contextId, returnByValue: true, awaitPromise: true }, place.session);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

export const ROWS: Row[] = [
  {
    row: 1, page: "row01-trusted-events.html", modes: ["full", "naive"],
    async act(tab) {
      if (tab.naive) {
        await tab.main(`(() => { const t = document.getElementById('target'); t.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); t.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); t.click();
          document.dispatchEvent(new KeyboardEvent('keydown', {key: 'a'})); document.dispatchEvent(new KeyboardEvent('keyup', {key: 'a'}));
          document.getElementById('scroller').dispatchEvent(new WheelEvent('wheel', {deltaY: 120}));
          const touch = document.getElementById('touch'); try { touch.dispatchEvent(new TouchEvent('touchstart')); touch.dispatchEvent(new TouchEvent('touchend')); } catch {}
          touch.dispatchEvent(new PointerEvent('pointerdown', {pointerType: 'touch'})); })()`);
        return;
      }
      await tab.clickSelector("#target");
      await tab.key("a");
      const wheelAt = await tab.center("#scroller");
      await tab.move(wheelAt);
      await tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: 120 });
      const touchAt = await tab.center("#touch");
      await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchAt.x, y: touchAt.y, id: 1 }] });
      await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(200);
    },
  },
  {
    row: 2, page: "row02-user-activation.html", modes: ["full", "naive", "gesture-eval"],
    async act(tab) {
      if (tab.mode === "naive") {
        await tab.main(`document.getElementById('field').focus(); document.getElementById('field').dispatchEvent(new KeyboardEvent('keydown', {key: 'k', bubbles: true}))`);
        await sleep(5300);
        await tab.main(`document.getElementById('target').click()`);
        return;
      }
      if (tab.mode === "gesture-eval") {
        await tab.iso(`document.getElementById('field').focus(); document.getElementById('field').dispatchEvent(new KeyboardEvent('keydown', {key: 'k', bubbles: true}))`, { userGesture: true });
        await sleep(5300);
        await tab.iso(`document.getElementById('target').click()`, { userGesture: true });
        return;
      }
      await tab.iso(`document.getElementById('field').focus()`);
      await tab.key("k");
      await sleep(5300);
      await tab.clickSelector("#target");
    },
  },
  {
    row: 3, page: "row03-gesture-gated.html", modes: ["full", "gesture-eval"], headed: false, host: "localhost",
    async before(tab, context) {
      writeFileSync(join(context.scratch, "row03-upload.txt"), "row03 upload body");
      await tab.send("Page.setInterceptFileChooserDialog", { enabled: true });
      await tab.send("WebAuthn.enable");
      const { authenticatorId } = await tab.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      context.notes.virtualAuthenticator = authenticatorId;
    },
    async act(tab, context) {
      await sleep(1500);
      const tap = async (selector: string) => tab.mode === "gesture-eval" ? tab.iso(`document.querySelector(${JSON.stringify(selector)}).click()`, { userGesture: true }) : tab.clickSelector(selector);
      for (const id of ["#popup", "#fullscreen", "#autoplay", "#payment"]) {
        await tap(id);
        await sleep(1200);
      }
      await tap("#clip");
      await sleep(3500);
      const origin = new URL(context.base).origin;
      await context.cdp.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], browserContextId: context.browserContextId });
      await tap("#clip");
      await sleep(800);
      const chooser = tab.waitEvent("Page.fileChooserOpened", 4000).catch(() => null);
      await tap("#pick");
      const opened = await chooser;
      context.notes.inputChooserIntercepted = !!opened;
      if (opened) await tab.send("DOM.setFileInputFiles", { files: [join(context.scratch, "row03-upload.txt")], backendNodeId: opened.params.backendNodeId });
      const fsaChooser = tab.waitEvent("Page.fileChooserOpened", 4500).catch(() => null);
      await tap("#fsa");
      const fsaOpened = await fsaChooser;
      context.notes.showOpenFilePickerIntercepted = fsaOpened ? fsaOpened.params : false;
      await sleep(500);
      await tap("#cred");
      await sleep(5500);
      const targets = (await context.cdp.send("Target.getTargets")).targetInfos;
      context.notes.leftoverTargets = targets.filter((target: any) => target.type !== "browser").map((target: any) => `${target.type}:${target.url.slice(0, 40)}`);
    },
  },
  {
    row: 4, page: "row04-pointer-movement.html", modes: ["full", "naive"],
    async act(tab, context) {
      if (tab.naive) {
        await tab.main(`(() => { const pad = document.getElementById('pad'); for (let i = 0; i < 40; i++) pad.dispatchEvent(new PointerEvent('pointermove', {clientX: 20 + i * 5, clientY: 60, movementX: 5, bubbles: true}));
          const hover = document.getElementById('hover'); hover.dispatchEvent(new PointerEvent('pointerenter')); hover.dispatchEvent(new MouseEvent('mouseover', {bubbles: true})); })()`);
        return;
      }
      const pad = await tab.iso<{ left: number; top: number; width: number; height: number }>(`(() => { const b = document.getElementById('pad').getBoundingClientRect(); return {left: b.left, top: b.top, width: b.width, height: b.height}; })()`);
      const start = { x: pad.left + 10, y: pad.top + 20 };
      await tab.move(start);
      await humanPath(tab, start, { x: pad.left + pad.width - 20, y: pad.top + pad.height - 30 }, 40, 8);
      const burstFrom = { x: pad.left + pad.width - 20, y: pad.top + pad.height - 30 };
      const sends = [];
      for (let step = 1; step <= 20; step++) sends.push(tab.move({ x: burstFrom.x - step * 8, y: burstFrom.y - step * 3 }));
      await Promise.all(sends);
      context.notes.burstSentWithoutAwait = 20;
      const hover = await tab.center("#hover");
      await humanPath(tab, { x: burstFrom.x - 160, y: burstFrom.y - 60 }, hover, 25, 8);
      await sleep(150);
    },
  },
  {
    row: 5, page: "row05-focus-ime.html", modes: ["full", "naive"],
    async act(tab, context) {
      if (tab.naive) {
        await tab.main(`(() => { const a = document.getElementById('a'), b = document.getElementById('b'); a.focus(); b.focus();
          b.dispatchEvent(new CompositionEvent('compositionstart', {data: ''})); b.dispatchEvent(new CompositionEvent('compositionupdate', {data: 'に'})); b.dispatchEvent(new CompositionEvent('compositionend', {data: '日本'}));
          b.value = '日x'; b.dispatchEvent(new InputEvent('beforeinput', {inputType: 'insertText', data: 'x'})); })()`);
        return;
      }
      const hasFocus = () => tab.iso<boolean>("document.hasFocus()");
      context.notes.hasFocusBeforeInput = await hasFocus();
      await tab.clickSelector("#a");
      await tab.clickSelector("#b");
      await tab.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
      await tab.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
      await tab.send("Input.insertText", { text: "日本" });
      await tab.key("Backspace");
      await tab.send("Input.insertText", { text: "x" });
      context.notes.hasFocusAfterInput = await hasFocus();
      await tab.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      context.notes.hasFocusWithFocusEmulation = await hasFocus();
      await tab.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      context.notes.visibility = await tab.iso("document.visibilityState");
      await tab.writeRead(context.notes);
    },
  },
  {
    row: 6, page: "row06-drag-drop.html", modes: ["full", "naive"],
    async act(tab, context) {
      writeFileSync(join(context.scratch, "row06-a.txt"), "row06 file a contents");
      writeFileSync(join(context.scratch, "row06-b.txt"), "row06 file b");
      if (tab.naive) {
        await tab.main(`(() => { const data = new DataTransfer(); const src = document.getElementById('src'), dst = document.getElementById('dst');
          src.dispatchEvent(new DragEvent('dragstart', {dataTransfer: data, bubbles: true})); dst.dispatchEvent(new DragEvent('drop', {dataTransfer: data, bubbles: true, cancelable: true}));
          const files = new DataTransfer(); files.items.add(new File(['row06 file a contents'], 'row06-a.txt')); files.items.add(new File(['row06 file b'], 'row06-b.txt'));
          document.getElementById('files').dispatchEvent(new DragEvent('drop', {dataTransfer: files, bubbles: true, cancelable: true}));
          const first = document.querySelector('#sort li'); const box = document.querySelector('#sort li:last-child').getBoundingClientRect();
          first.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); document.dispatchEvent(new MouseEvent('mousemove', {clientY: box.top + 4})); document.dispatchEvent(new MouseEvent('mouseup')); })()`);
        await sleep(300);
        return;
      }
      const src = await tab.center("#src");
      const dst = await tab.center("#dst");
      await tab.send("Input.setInterceptDrags", { enabled: true });
      const intercepted = tab.waitEvent("Input.dragIntercepted", 4000).catch(() => null);
      await tab.move(src);
      await tab.press(src);
      for (let step = 1; step <= 6; step++) await tab.move({ x: src.x + step * 6, y: src.y + step * 2 }, { buttons: 1 });
      const drag = await intercepted;
      context.notes.dragIntercepted = !!drag;
      if (drag) {
        for (const type of ["dragEnter", "dragOver", "drop"]) await tab.send("Input.dispatchDragEvent", { type, x: dst.x, y: dst.y, data: drag.params.data, modifiers: 0 });
      }
      await tab.release(dst);
      await tab.send("Input.setInterceptDrags", { enabled: false });
      const zone = await tab.center("#files");
      const data = { items: [], files: [join(context.scratch, "row06-a.txt"), join(context.scratch, "row06-b.txt")], dragOperationsMask: 1 };
      for (const type of ["dragEnter", "dragOver", "drop"]) await tab.send("Input.dispatchDragEvent", { type, x: zone.x, y: zone.y, data, modifiers: 0 });
      await sleep(200);
      const first = await tab.center('#sort li[data-id="1"]');
      const target = await tab.iso<Point>(`(() => { const b = document.querySelector('#sort li[data-id="5"]').getBoundingClientRect(); return {x: b.left + 20, y: b.top + 4}; })()`);
      await tab.move(first);
      await tab.press(first);
      const steps = 12;
      for (let step = 1; step <= steps; step++) await tab.move({ x: first.x + (target.x - first.x) * step / steps, y: first.y + (target.y - first.y) * step / steps }, { buttons: 1 });
      await tab.release(target);
      await sleep(200);
    },
  },
  {
    row: 7, page: "row07-webdriver.html", modes: ["full"],
    async act() { await sleep(200); },
  },
  {
    row: 8, page: "row08-session-side-effects.html", modes: ["full", "naive", "naive-debugger"],
    async act(tab) {
      await sleep(500);
      if (tab.naive) await tab.main(`document.getElementById('target').click()`);
      else await tab.clickSelector("#target");
      await sleep(1500);
    },
  },
  {
    row: 9, page: "row09-globals-stacks.html", modes: ["full", "naive"],
    async before(tab) {
      if (tab.naive) await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__driverBinding = function () {};" });
      else await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__ardiaIsolatedProbe = 1;", worldName: "ardia-human" });
    },
    async act(tab) {
      if (tab.naive) {
        await tab.main(`window.__driverState = {}; document.getElementById('target').click()\n//# sourceURL=__puppeteer_evaluation_script__`);
        return;
      }
      await tab.iso(`window.__ardiaIsolatedGlobal = true; document.querySelectorAll('button').length`);
      await tab.clickSelector("#target");
      await sleep(100);
    },
  },
  {
    row: 10, page: "row10-timing.html", modes: ["full", "naive-debugger"],
    async open(context) {
      const { targetId } = await context.cdp.send("Target.createTarget", { url: pageUrl(context, "row10-timing.html"), browserContextId: context.browserContextId });
      await sleep(2000);
      return Tab.attach(context.cdp, targetId, context.mode, context.browserContextId);
    },
    async act(tab, context) {
      const phase = (name: string) => tab.iso(`document.documentElement.dataset.phase = ${JSON.stringify(name)}`);
      await phase("attached-idle");
      await sleep(1200);
      await phase("actions");
      if (tab.naive) {
        for (let i = 0; i < 10; i++) await tab.main(`document.getElementById('target').click(); document.querySelectorAll('*').length`);
        await tab.main(`document.getElementById('field').value = 'hello world'`);
      } else {
        await tab.clickSelector("#target");
        await tab.clickSelector("#field");
        await tab.type("hello world");
        for (let i = 0; i < 10; i++) await tab.iso(`document.querySelectorAll('*').length`);
        await humanPath(tab, { x: 300, y: 300 }, { x: 100, y: 100 }, 30, 10);
      }
      await sleep(800);
      await phase("screenshot");
      for (let i = 0; i < 3; i++) await tab.send("Page.captureScreenshot", { format: "png" });
      await phase("after");
      await sleep(1000);
      context.notes.screenshotTaken = 3;
    },
  },
  {
    row: 11, page: "row11-banners.html", modes: ["full"],
    async open(context) {
      const { targetId } = await context.cdp.send("Target.createTarget", { url: pageUrl(context, "row11-banners.html"), browserContextId: context.browserContextId });
      await sleep(3000);
      return Tab.attach(context.cdp, targetId, context.mode, context.browserContextId);
    },
    async act(tab, context) {
      await tab.iso(`document.documentElement.dataset.phase = 'attached'`);
      await sleep(1500);
      await tab.clickSelector("p");
      await tab.iso(`document.documentElement.dataset.phase = 'acted'`);
      await sleep(800);
      const { windowId } = await context.cdp.send("Browser.getWindowForTarget", { targetId: tab.targetId });
      context.notes.windowBounds = (await context.cdp.send("Browser.getWindowBounds", { windowId })).bounds;
      await tab.writeRead({ headless: context.launch.headless, reference: context.baselines.reference ?? null, flags: context.launch.flags.filter(flag => !flag.startsWith("--user-data-dir")) });
    },
  },
  {
    row: 12, page: "row12-closed-shadow.html", modes: ["full", "naive"],
    async act(tab, context) {
      if (tab.naive) {
        const read = await tab.main(`(() => { const host = document.getElementById('host'); const button = document.querySelector('#deep'); if (button) button.click(); return {text: host.shadowRoot?.textContent ?? null}; })()`);
        await tab.writeRead(read);
        return;
      }
      const nodes = await walkDom(tab);
      const deep = nodes.find(node => attribute(node, "id") === "deep");
      const text = nodes.find(node => attribute(node, "id") === "text");
      context.notes.shadowRootTypes = [...new Set(nodes.filter(node => node.inShadow).map(node => node.inShadow))];
      const read = { text: text ? await nodeText(tab, text.nodeId) : null };
      if (deep) await tab.click(await nodeCenter(tab, deep.nodeId));
      await tab.writeRead(read);
    },
  },
  {
    row: 13, page: "row13-iframes.html", modes: ["full", "naive"],
    async before(tab, context) {
      if (tab.naive) return;
      const sessions: string[] = [];
      context.notes.attached = [];
      tab.cdp.on(message => {
        if (message.method !== "Target.attachedToTarget") return;
        const { sessionId, targetInfo } = message.params;
        if (message.sessionId !== tab.sessionId && !sessions.includes(message.sessionId!)) return;
        sessions.push(sessionId);
        (context.notes.attached as string[]).push(`${targetInfo.type}:${new URL(targetInfo.url || "about:blank").searchParams.get("role") ?? targetInfo.url}`);
        tab.cdp.fire("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
      });
      context.notes.sessions = sessions;
      await tab.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    },
    async act(tab, context) {
      if (tab.naive) {
        const read = await tab.main(`(() => { const out = {}; for (const frame of document.querySelectorAll('iframe')) { try { out[new URL(frame.src).searchParams.get('role')] = frame.contentDocument?.getElementById('secret')?.textContent ?? null; } catch (error) { out.error = String(error).slice(0, 80); } } try { frames[0].document.getElementById('act').click(); } catch (error) { out.clickError = String(error).slice(0, 80); } return out; })()`);
        await tab.writeRead(read);
        return;
      }
      await sleep(1500);
      const sessions = [tab.sessionId, ...(context.notes.sessions as string[])];
      const places = await frameContexts(tab.cdp, sessions);
      context.notes.roles = Object.fromEntries(Object.entries(places).map(([role, place]) => [role, place.session === tab.sessionId ? "top session" : "own session"]));
      const read: Record<string, string> = {};
      for (const role of ["child", "grandchild", "sandboxed"]) {
        if (places[role]) read[role] = await isoIn(tab.cdp, places[role], `document.getElementById('secret').textContent`);
      }
      const frameOffset = (place: { session: string; contextId: number }, role: string) => isoIn(tab.cdp, place, `(() => { const frame = [...document.querySelectorAll('iframe')].find(f => f.src.includes('role=${role}')); const b = frame.getBoundingClientRect(); return {x: b.left + frame.clientLeft, y: b.top + frame.clientTop}; })()`);
      const buttonIn = (place: { session: string; contextId: number }) => isoIn(tab.cdp, place, `(() => { const b = document.getElementById('act').getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2}; })()`);
      const top = places.top;
      const offsets: Record<string, Point> = {};
      offsets.child = await frameOffset(top, "child");
      offsets.sandboxed = await frameOffset(top, "sandboxed");
      if (places.child) {
        const inner = await frameOffset(places.child, "grandchild");
        offsets.grandchild = { x: offsets.child.x + inner.x, y: offsets.child.y + inner.y };
      }
      context.notes.clicks = {};
      for (const role of ["child", "grandchild", "sandboxed"]) {
        if (!places[role] || !offsets[role]) continue;
        const local = await buttonIn(places[role]);
        const point = { x: offsets[role].x + local.x, y: offsets[role].y + local.y };
        await tab.click(point);
        (context.notes.clicks as any)[role] = point;
        await sleep(150);
      }
      await tab.writeRead(read);
      await sleep(200);
    },
  },
  {
    row: 14, page: "row14-pickers-permissions.html", modes: ["full"],
    async act(tab, context) {
      const origin = new URL(context.base).origin;
      const targetsBefore = (await context.cdp.send("Target.getTargets")).targetInfos.length;
      for (const id of ["#geo", "#notify", "#camera"]) await tab.clickSelector(id);
      await sleep(5500);
      await context.cdp.send("Browser.grantPermissions", { origin, permissions: ["geolocation", "notifications", "videoCapture"], browserContextId: context.browserContextId });
      await tab.send("Emulation.setGeolocationOverride", { latitude: 37.7749, longitude: -122.4194, accuracy: 10 });
      for (const id of ["#geo", "#notify", "#camera"]) await tab.clickSelector(id);
      await sleep(3000);
      await tab.iso(`document.getElementById('fruit').focus()`);
      await tab.key("b");
      await sleep(200);
      if (context.launch.headless) {
        await tab.clickSelector("#fruit");
        await sleep(400);
        await tab.key("ArrowDown");
        await tab.key("Enter");
        await sleep(300);
        context.notes.selectAfterPopupKeys = await tab.iso(`document.getElementById('fruit').value`);
      }
      await tab.iso(`document.getElementById('date').focus()`);
      await tab.type("11192026");
      await tab.key("Tab");
      await sleep(200);
      if (context.launch.headless) {
        await tab.clickSelector("#color");
        await sleep(800);
        await tab.key("Enter");
        await sleep(300);
        await tab.key("Escape");
      }
      const targetsAfter = (await context.cdp.send("Target.getTargets")).targetInfos;
      context.notes.targetsBefore = targetsBefore;
      context.notes.targetsAfter = targetsAfter.map((target: any) => `${target.type}:${target.url.slice(0, 50)}`);
      await sleep(300);
    },
  },
  {
    row: 15, page: "row15-downloads-uploads.html", modes: ["full"],
    async act(tab, context) {
      const folder = join(context.scratch, `downloads-${context.mode}-${Date.now()}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(context.scratch, "row15-up-1.txt"), "row15 upload one");
      writeFileSync(join(context.scratch, "row15-up-2.txt"), "row15 upload two");
      await context.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: folder, eventsEnabled: true, browserContextId: context.browserContextId });
      const completed: string[] = [];
      const off = context.cdp.on(message => {
        if (message.method === "Browser.downloadProgress" && message.params.state === "completed") completed.push(message.params.guid);
      });
      await tab.clickSelector("#served");
      await tab.clickSelector("#blob");
      const deadline = Date.now() + 10000;
      while (completed.length < 2 && Date.now() < deadline) await sleep(100);
      off();
      await tab.send("Page.setInterceptFileChooserDialog", { enabled: true });
      const chooser = tab.waitEvent("Page.fileChooserOpened", 4000).catch(() => null);
      await tab.clickSelector("#upload");
      const opened = await chooser;
      if (opened) await tab.send("DOM.setFileInputFiles", { files: [join(context.scratch, "row15-up-1.txt"), join(context.scratch, "row15-up-2.txt")], backendNodeId: opened.params.backendNodeId });
      await sleep(300);
      const downloads = existsSync(folder) ? readdirSync(folder).map(name => ({ name, size: statSync(join(folder, name)).size, inFolder: true })) : [];
      await tab.writeRead({ downloads, dialogs: opened ? 0 : 1, completedEvents: completed.length });
    },
  },
  {
    row: 16, page: "row16-print-save.html", modes: ["full"],
    async act(tab, context) {
      const { data } = await tab.send("Page.printToPDF", { printBackground: true });
      const pdf = Buffer.from(data, "base64");
      const pdfText = pdf.toString("latin1");
      const { data: mhtml } = await tab.send("Page.captureSnapshot", { format: "mhtml" });
      const before = new Set((await context.cdp.send("Target.getTargets")).targetInfos.map((target: any) => target.targetId));
      const point = await tab.center("#print");
      const clicked = tab.click(point).then(() => "returned", error => String(error));
      const outcome = await Promise.race([clicked, sleep(4000).then(() => "click still pending after 4s")]);
      const after = (await context.cdp.send("Target.getTargets")).targetInfos.filter((target: any) => !before.has(target.targetId));
      context.notes.printClick = outcome;
      context.notes.newTargetsAfterPrint = after.map((target: any) => `${target.type}:${target.url}`);
      const printTarget = after.find((target: any) => /print/.test(target.url));
      let printDialogAnswered = false;
      if (printTarget) {
        context.notes.printPreviewTarget = printTarget.url;
        const answered = await context.cdp.send("Target.closeTarget", { targetId: printTarget.targetId }).then(() => true, () => false);
        context.notes.printPreviewClosedOverCdp = answered;
        await sleep(500);
      }
      const responsive = await Promise.race([tab.iso("1").then(() => true, () => false), sleep(3000).then(() => false)]);
      context.notes.pageResponsiveAfterPrint = responsive;
      if (responsive) await tab.writeRead({ pdfHeader: pdfText.slice(0, 5), pdfBytes: pdf.length, pdfPages: (pdfText.match(/\/Type\s*\/Page[^s]/g) ?? []).length, mhtmlHasMarker: mhtml.includes("row16-print-marker"), printDialogAnswered });
    },
  },
  {
    row: 17, page: "row17-browser-ui.html", modes: ["full"],
    async act(tab, context) {
      const targetsBefore = new Set((await context.cdp.send("Target.getTargets")).targetInfos.map((target: any) => target.targetId));
      await tab.iso(`document.getElementById('field').focus()`);
      await tab.key("t", { modifiers: [commandKey] });
      await sleep(1000);
      const newTargets = (await context.cdp.send("Target.getTargets")).targetInfos.filter((target: any) => !targetsBefore.has(target.targetId) && target.type === "page");
      for (const target of newTargets) await context.cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
      await tab.iso(`document.getElementById('field').focus()`);
      await tab.key("l", { modifiers: [commandKey] });
      await sleep(500);
      const focus = await tab.iso<{ active: string; hasFocus: boolean }>(`({active: document.activeElement?.id ?? document.activeElement?.tagName, hasFocus: document.hasFocus()})`);
      const { windowId, bounds } = await context.cdp.send("Browser.getWindowForTarget", { targetId: tab.targetId });
      let windowBoundsChanged = false;
      try {
        await context.cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: (bounds.width ?? 1100) - 40 } });
        const now = (await context.cdp.send("Browser.getWindowBounds", { windowId })).bounds;
        windowBoundsChanged = now.width === (bounds.width ?? 1100) - 40;
        await context.cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: bounds.width } });
      } catch (error) {
        context.notes.windowBoundsError = String(error);
      }
      const command = await context.cdp.send("Browser.executeBrowserCommand", { commandId: "openTabSearch" }).then(() => "ok", (error: Error) => error.message);
      await context.cdp.send("Browser.executeBrowserCommand", { commandId: "closeTabSearch" }).catch(() => {});
      context.notes.executeBrowserCommand = command;
      context.notes.focusAfterCommandL = focus;
      await tab.writeRead({ newTabFromShortcut: newTargets.length > 0, omniboxFocused: focus.hasFocus === false, windowBoundsChanged, menuReachable: false, executeBrowserCommand: command });
    },
  },
  {
    row: 18, page: "row18-canvas-webgl.html", modes: ["full"],
    async act(tab, context) {
      await sleep(300);
      const dpr = await tab.iso<number>("devicePixelRatio");
      const { data } = await tab.send("Page.captureScreenshot", { format: "png" });
      const image = decodePng(new Uint8Array(Buffer.from(data, "base64")));
      const red = centroid(image, (r, g, b) => r > 200 && g < 70 && b < 70);
      const blue = centroid(image, (r, g, b) => b > 200 && r < 70 && g < 90);
      context.notes.located = { dpr, red, blue, screenshot: { width: image.width, height: image.height } };
      if (red) await tab.click({ x: red.x / dpr, y: red.y / dpr });
      if (blue) await tab.click({ x: blue.x / dpr, y: blue.y / dpr });
      const flatUrl = await tab.iso<string>(`document.getElementById('flat').toDataURL('image/png')`);
      const glUrl = await tab.iso<string>(`document.getElementById('gl').toDataURL('image/png')`);
      const glImage = decodePng(new Uint8Array(Buffer.from(glUrl.split(",")[1], "base64")));
      const glReadback = { hasBlue: !!centroid(glImage, (r, g, b) => b > 235 && r < 30 && g < 30) };
      await tab.writeRead({ flatDigest: sha256(flatUrl), glReadback, located: context.notes.located });
    },
  },
  {
    row: 19, page: "row19-virtual-list.html", modes: ["full", "naive"],
    async act(tab, context) {
      const wanted = "Open 5000";
      if (tab.naive) {
        const read = await tab.main(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(wanted)}); if (button) button.click(); return {found: !!button}; })()`);
        await tab.writeRead(read);
        return;
      }
      const started = Date.now();
      let steps = 0;
      const viewportCenter = await tab.center("#viewport");
      await tab.move(viewportCenter);
      for (; steps < 60; steps++) {
        const state = await tab.iso<any>(`(() => {
          const viewport = document.getElementById('viewport'); const box = viewport.getBoundingClientRect();
          const rows = [...document.querySelectorAll('[data-index]')].map(row => ({index: Number(row.dataset.index), top: row.getBoundingClientRect().top}));
          const button = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(wanted)});
          let target = null;
          if (button) { const b = button.getBoundingClientRect(); if (b.top >= box.top && b.bottom <= box.bottom) target = {x: b.left + b.width / 2, y: b.top + b.height / 2}; }
          const visible = rows.filter(row => row.top >= box.top - 1 && row.top < box.bottom);
          return {target, first: visible[0], last: visible[visible.length - 1], viewportTop: box.top, viewportHeight: box.height};
        })()`);
        if (state.target) {
          await tab.click(state.target);
          break;
        }
        const span = state.last.index - state.first.index || 1;
        const pixelsPerIndex = (state.last.top - state.first.top) / span || 30;
        const wantedIndex = Number(wanted.split(" ")[1]);
        const delta = (wantedIndex - state.first.index) * pixelsPerIndex - state.viewportHeight / 2;
        const clamped = Math.max(-60000, Math.min(60000, delta));
        await tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: viewportCenter.x, y: viewportCenter.y, deltaX: 0, deltaY: clamped });
        await tab.iso(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await sleep(60);
      }
      await tab.writeRead({ steps: steps + 1, ms: Date.now() - started });
    },
  },
  {
    row: 20, page: "row20-rich-editors.html", modes: ["full", "naive"],
    async act(tab, context) {
      if (tab.naive) {
        const read = await tab.main(`(() => { const plain = document.getElementById('plain'); plain.focus(); document.execCommand('insertText', false, 'hello world'); document.execCommand('undo');
          const model = document.getElementById('model'); model.focus(); document.execCommand('insertText', false, 'hello world'); return {afterReplace: model.textContent}; })()`);
        await tab.writeRead(read);
        return;
      }
      await tab.clickSelector("#plain");
      await tab.type("hello world");
      await tab.key("z", { modifiers: [commandKey] });
      context.notes.plainAfterUndoWithoutCommands = await tab.iso(`document.getElementById('plain').textContent`);
      await tab.key("z", { modifiers: [commandKey], commands: ["undo"] });
      context.notes.plainAfterUndoWithCommands = await tab.iso(`document.getElementById('plain').textContent`);
      await tab.clickSelector("#model");
      await tab.type("hello world");
      const word = await tab.iso<Point>(`(() => { const node = document.getElementById('model').firstChild; const range = document.createRange(); range.setStart(node, 7); range.setEnd(node, 9); const b = range.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2}; })()`);
      await tab.click(word, 2);
      context.notes.selectionAfterDoubleClick = await tab.iso(`getSelection().toString()`);
      await tab.send("Input.insertText", { text: "ardia" });
      const afterReplace = await tab.iso(`document.getElementById('model').textContent`);
      await tab.key("z", { modifiers: [commandKey], commands: ["undo"] });
      await tab.writeRead({ afterReplace, ...context.notes });
    },
  },
  {
    row: 21, page: "row21-custom-elements.html", modes: ["full", "naive"],
    async act(tab, context) {
      if (tab.naive) {
        await tab.main(`(() => { const input = document.querySelector('x-field').shadowRoot.querySelector('input'); input.value = 'ardia-user'; input.dispatchEvent(new Event('input'));
          document.querySelector('x-toggle').shadowRoot?.querySelector('button')?.click(); document.getElementById('form').requestSubmit(document.getElementById('submit')); })()`);
        return;
      }
      const input = await tab.iso<Point>(`(() => { const b = document.querySelector('x-field').shadowRoot.querySelector('input').getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2}; })()`);
      await tab.click(input);
      await tab.type("ardia-user");
      const nodes = await walkDom(tab);
      const toggle = nodes.find(node => node.nodeName === "BUTTON" && node.inShadow === "closed");
      context.notes.foundClosedButton = !!toggle;
      if (toggle) await tab.click(await nodeCenter(tab, toggle.nodeId));
      await tab.clickSelector("#submit");
      await sleep(200);
    },
  },
  {
    row: 22, page: "row22-settle.html", modes: ["full", "naive"],
    async open(context) {
      const tab = await Tab.open(context.cdp, context.mode, { browserContextId: context.browserContextId });
      if (context.mode === "full") await tab.send("Network.enable");
      return tab;
    },
    async act(tab, context) {
      if (tab.naive) {
        await sleep(500);
        await tab.main(`document.getElementById('go').click()`);
        await sleep(3000);
        return;
      }
      const started = Date.now();
      const inflight = new Set<string>();
      let lastNetwork = Date.now();
      const off = tab.cdp.on(message => {
        if (message.sessionId !== tab.sessionId) return;
        if (message.method === "Network.requestWillBeSent") { inflight.add(message.params.requestId); lastNetwork = Date.now(); }
        if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") { inflight.delete(message.params.requestId); lastNetwork = Date.now(); }
      });
      for (const event of tab.events) if (event.method === "Network.requestWillBeSent") inflight.add(event.params.requestId);
      for (const event of tab.events) if (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed") inflight.delete(event.params.requestId);
      await tab.iso(`(() => {
        const state = window.__settle = {lastShift: 0, lastMutation: 0, lastLongFrame: 0, lastLongTask: 0, shifts: 0};
        new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) { state.lastShift = performance.now(); state.shifts++; } }).observe({type: 'layout-shift', buffered: true});
        try { new PerformanceObserver(() => { state.lastLongTask = performance.now(); }).observe({type: 'longtask'}); } catch {}
        new MutationObserver(() => { state.lastMutation = performance.now(); }).observe(document, {subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: undefined});
        let previous = performance.now();
        const frame = now => { if (now - previous > 50) state.lastLongFrame = now; previous = now; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      })()`);
      const QUIET = 500;
      let signals: any = null;
      while (Date.now() - started < 10000) {
        await sleep(100);
        const page = await tab.iso<any>(`(() => { const s = window.__settle; const now = performance.now(); return {sinceShift: now - s.lastShift, sinceMutation: now - s.lastMutation, sinceLongFrame: now - s.lastLongFrame, sinceLongTask: now - s.lastLongTask, shifts: s.shifts, readyState: document.readyState}; })()`);
        const networkQuiet = inflight.size === 0 && Date.now() - lastNetwork >= QUIET;
        signals = { ...page, inflight: inflight.size, sinceNetwork: Date.now() - lastNetwork };
        if (networkQuiet && page.readyState === "complete" && page.sinceShift >= QUIET && page.sinceMutation >= QUIET && page.sinceLongFrame >= QUIET && page.sinceLongTask >= QUIET) break;
      }
      off();
      await tab.clickSelector("#go");
      await tab.writeRead({ settleMs: Date.now() - started, signals });
      await sleep(100);
    },
  },
];
