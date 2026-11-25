import { Cdp, type Message } from "./cdp";

export type Mode = "full" | "naive" | "naive-debugger" | "gesture-eval";

export const WORLD_NAME = "ardia-human";

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

const SPECIAL_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Backspace: { code: "Backspace", keyCode: 8 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

function keyDefinition(key: string) {
  if (SPECIAL_KEYS[key]) return { key, ...SPECIAL_KEYS[key] };
  if (/^[a-z]$/i.test(key)) return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  if (key === "-") return { key, code: "Minus", keyCode: 189, text: key };
  return { key, code: "", keyCode: 0, text: key };
}

export type Point = { x: number; y: number };

export class Tab {
  private contextId?: number;
  private frameIdCache?: string;
  readonly events: Message[] = [];
  private offEvents: () => void;

  constructor(readonly cdp: Cdp, readonly sessionId: string, readonly targetId: string, readonly mode: Mode, readonly browserContextId?: string) {
    this.offEvents = cdp.on(message => { if (message.sessionId === sessionId && message.method) this.events.push(message); });
  }

  static async open(cdp: Cdp, mode: Mode, options: { browserContextId?: string; url?: string } = {}) {
    const { targetId } = await cdp.send("Target.createTarget", { url: options.url ?? "about:blank", browserContextId: options.browserContextId });
    return Tab.attach(cdp, targetId, mode, options.browserContextId);
  }

  static async attach(cdp: Cdp, targetId: string, mode: Mode, browserContextId?: string) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, targetId, mode, browserContextId);
    await tab.send("Page.enable");
    if (mode === "naive" || mode === "naive-debugger") {
      await tab.send("Runtime.enable");
      await tab.send("Log.enable");
    }
    if (mode === "naive-debugger") {
      cdp.on(message => { if (message.sessionId === sessionId && message.method === "Debugger.paused") cdp.fire("Debugger.resume", {}, sessionId); });
      await tab.send("Debugger.enable");
    }
    return tab;
  }

  send<T = any>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
  }

  waitEvent(method: string, timeoutMs: number, predicate: (params: any) => boolean = () => true) {
    return this.cdp.waitFor(message => message.sessionId === this.sessionId && message.method === method && predicate(message.params), timeoutMs, method);
  }

  get naive() {
    return this.mode !== "full";
  }

  async goto(url: string) {
    const loaded = this.waitEvent("Page.loadEventFired", 20000);
    await this.send("Page.navigate", { url });
    await loaded;
    this.contextId = undefined;
    this.frameIdCache = undefined;
  }

  async frameId() {
    if (!this.frameIdCache) this.frameIdCache = (await this.send("Page.getFrameTree")).frameTree.frame.id;
    return this.frameIdCache!;
  }

  async isolatedContext() {
    if (this.contextId === undefined) {
      const { executionContextId } = await this.send("Page.createIsolatedWorld", { frameId: await this.frameId(), worldName: WORLD_NAME });
      this.contextId = executionContextId;
    }
    return this.contextId!;
  }

  async iso<T = any>(expression: string, extra: object = {}): Promise<T> {
    const contextId = await this.isolatedContext();
    const response = await this.send("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true, ...extra });
    if (response.exceptionDetails) throw new Error(`isolated eval failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
    return response.result.value as T;
  }

  async main<T = any>(expression: string, extra: object = {}): Promise<T> {
    const response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...extra });
    if (response.exceptionDetails) return { error: response.exceptionDetails.exception?.description ?? response.exceptionDetails.text } as T;
    return response.result.value as T;
  }

  eval<T = any>(expression: string) {
    return this.naive ? this.main<T>(expression) : this.iso<T>(expression);
  }

  async center(selector: string): Promise<Point> {
    const point = await this.iso<Point | null>(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; element.scrollIntoView({block: 'nearest', inline: 'nearest'}); const box = element.getBoundingClientRect(); return {x: box.left + box.width / 2, y: box.top + box.height / 2}; })()`);
    if (!point) throw new Error(`no element for ${selector}`);
    return point;
  }

  async move(point: Point, options: { buttons?: number } = {}) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, buttons: options.buttons ?? 0, button: options.buttons ? "left" : "none" });
  }

  async press(point: Point, clickCount = 1) {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount });
  }

  async release(point: Point, clickCount = 1) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount });
  }

  async click(point: Point, clickCount = 1) {
    await this.move(point);
    for (let count = 1; count <= clickCount; count++) {
      await this.press(point, count);
      await this.release(point, count);
    }
  }

  async clickSelector(selector: string) {
    const point = await this.center(selector);
    await this.click(point);
    return point;
  }

  async key(key: string, options: { modifiers?: (keyof typeof MODIFIERS)[]; commands?: string[] } = {}) {
    const definition = keyDefinition(key);
    const modifiers = (options.modifiers ?? []).reduce((sum, name) => sum | MODIFIERS[name], 0);
    const text = modifiers & (MODIFIERS.meta | MODIFIERS.ctrl) ? undefined : definition.text;
    await this.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown", key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode, text, unmodifiedText: text, modifiers, commands: options.commands,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, nativeVirtualKeyCode: definition.keyCode, modifiers });
  }

  async type(text: string) {
    for (const character of text) await this.key(character);
  }

  async writeRead(value: unknown) {
    await this.eval(`document.documentElement.dataset.read = ${JSON.stringify(JSON.stringify(value))}`);
  }

  async finish(timeoutMs = 15000) {
    await this.eval(`document.documentElement.setAttribute('data-finish', '1')`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = await this.iso<string | undefined>(`document.documentElement.dataset.humanResult`);
      if (raw) return JSON.parse(raw);
      await Bun.sleep(100);
    }
    throw new Error("page did not report within the deadline");
  }

  async close() {
    this.offEvents();
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }
}
