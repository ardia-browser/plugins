import { pyLen } from "../../pylib/str.ts";
import { rng } from "../../pylib/random.ts";
import { Cancelled, later, shield, sleep, withSignal } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost, OutcomeUnknown } from "../daemon-errors.ts";
import { Page, type PageInput, type Viewport, type Element } from "../state/page.ts";
import { roundCoordinate } from "./human.ts";
import { FocusedKeyTarget, type HeldKeys, Keyboard, KeyTarget } from "./keyboard.ts";
import { EDITING_SHORTCUTS, MODIFIER_BITS, MODIFIER_KEYS, parseCombo, parseKey, RELEASE_TIMEOUT } from "./keys.ts";
import { Mouse } from "./mouse.ts";

const MAC_EDITING: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    "Meta+a": ["selectAll"],
    "Meta+c": ["copy"],
    "Meta+x": ["cut"],
    "Meta+v": ["paste"],
    "Meta+z": ["undo"],
    "Meta+Shift+z": ["redo"],
    "Meta+ArrowLeft": ["moveToLeftEndOfLine"],
    "Meta+ArrowRight": ["moveToRightEndOfLine"],
    "Meta+ArrowUp": ["moveToBeginningOfDocument"],
    "Meta+ArrowDown": ["moveToEndOfDocument"],
    "Meta+Shift+ArrowLeft": ["moveToLeftEndOfLineAndModifySelection"],
    "Meta+Shift+ArrowRight": ["moveToRightEndOfLineAndModifySelection"],
    "Meta+Shift+ArrowUp": ["moveToBeginningOfDocumentAndModifySelection"],
    "Meta+Shift+ArrowDown": ["moveToEndOfDocumentAndModifySelection"],
    "Meta+Backspace": ["deleteToBeginningOfLine"],
    "Meta+Delete": ["deleteToEndOfLine"],
    "Alt+ArrowLeft": ["moveWordLeft"],
    "Alt+ArrowRight": ["moveWordRight"],
    "Alt+ArrowUp": ["moveBackward", "moveToBeginningOfParagraph"],
    "Alt+ArrowDown": ["moveForward", "moveToEndOfParagraph"],
    "Alt+Shift+ArrowLeft": ["moveWordLeftAndModifySelection"],
    "Alt+Shift+ArrowRight": ["moveWordRightAndModifySelection"],
    "Alt+Backspace": ["deleteWordBackward"],
    "Alt+Delete": ["deleteWordForward"],
    "Alt+Shift+Backspace": ["deleteWordBackward"],
    "Alt+Shift+Delete": ["deleteWordForward"],
  }),
);

const CONTROL = MODIFIER_BITS["Control"] as number;
const META = MODIFIER_BITS["Meta"] as number;
const ALT = MODIFIER_BITS["Alt"] as number;
const SHIFT = MODIFIER_BITS["Shift"] as number;

export function editingCommands(bits: number, key: string, platform: string = process.platform): string[] | null {
  if (bits & (CONTROL | META) && pyLen(key) === 1) {
    const shortcut = JSON.stringify([key.toLowerCase(), ...(bits & SHIFT ? ["Shift"] : [])]);
    const command = EDITING_SHORTCUTS.get(shortcut);
    if (command !== undefined) return [command];
  }
  if (platform !== "darwin") return null;
  if (bits & CONTROL) return null;
  const meta = Boolean(bits & META);
  const alt = Boolean(bits & ALT);
  if (meta === alt) return null;
  const name = pyLen(key) === 1 ? key.toLowerCase() : key;
  const spec = `${meta ? "Meta" : "Alt"}${bits & SHIFT ? "+Shift" : ""}+${name}`;
  const found = MAC_EDITING.get(spec);
  return found ? [...found] : null;
}

type GestureOptions = { keepHeld?: boolean; allowHidden?: boolean };

export class Input implements PageInput {
  readonly heldKeys: HeldKeys = new Map();
  mouse: Mouse | null = null;
  heldTouch: { x: number; y: number; id: number } | null = null;

  constructor(readonly page: Page) {}

  bind(viewport: Viewport): void {
    if (this.mouse !== null) return;
    this.mouse = new Mouse(this.page);
    const [width, height] = viewport ?? [1280, 800];
    const random = rng();
    const x = random.uniform(0.3, 0.7) * width;
    const y = random.uniform(0.55, 0.9) * height;
    this.mouse.position = [x, y];
  }

  get pointer(): Mouse {
    if (this.mouse === null) this.bind(null);
    return this.mouse as Mouse;
  }

  get holding(): boolean {
    return this.heldKeys.size > 0 || this.heldTouch !== null || (this.mouse !== null && this.mouse.held !== null);
  }

  keyboard(element: Element | null = null, guard: (() => Promise<void>) | null = null): Keyboard {
    return new Keyboard(element !== null ? new FocusedKeyTarget(this.page, this.heldKeys, element, guard) : new KeyTarget(this.page, this.heldKeys));
  }

  async releaseHeld(): Promise<void> {
    if (this.heldTouch !== null) {
      try {
        await this.page.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }, { inputEvent: true, timeout: RELEASE_TIMEOUT });
      } finally {
        this.heldTouch = null;
      }
    }
    for (const [key, params] of [...this.heldKeys]) {
      const up: Record<string, unknown> = {};
      for (const name of ["key", "code", "windowsVirtualKeyCode"]) if (Object.hasOwn(params, name)) up[name] = params[name];
      up["type"] = "keyUp";
      try {
        await this.page.send("Input.dispatchKeyEvent", up, { inputEvent: true, timeout: RELEASE_TIMEOUT });
      } finally {
        this.heldKeys.delete(key);
      }
    }
    const mouse = this.mouse;
    if (mouse !== null && mouse.held !== null) {
      const button = mouse.held;
      const [x, y] = mouse.position;
      try {
        await this.page.send(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", x: roundCoordinate(x), y: roundCoordinate(y), button, clickCount: 1 },
          { inputEvent: true, timeout: RELEASE_TIMEOUT },
        );
      } finally {
        mouse.held = null;
        mouse.pressedButton = null;
      }
    }
  }

  async releaseAll(): Promise<boolean> {
    if (!this.holding) return true;
    const limit = new AbortController();
    const stop = later(RELEASE_TIMEOUT * 1000, () => limit.abort(new Cancelled()));
    try {
      await shield(() => withSignal(limit.signal, () => this.releaseHeld()));
      return true;
    } catch {
      this.heldKeys.clear();
      this.heldTouch = null;
      if (this.mouse !== null) {
        this.mouse.held = null;
        this.mouse.pressedButton = null;
      }
      return false;
    } finally {
      stop();
    }
  }

  async gesture<T>(action: string, run: () => Promise<T>, options: GestureOptions = {}): Promise<T> {
    if (!options.allowHidden && !this.holding) await this.page.requireVisible();
    let result: T;
    try {
      result = await run();
    } catch (error) {
      if (this.holding) {
        const released = await this.releaseAll();
        if (!released && !(error instanceof Cancelled || error instanceof ConnectionLost || error instanceof OutcomeUnknown)) {
          throw new OutcomeUnknown(action, "a held key or mouse button couldn't be released");
        }
      }
      throw error;
    }
    if (this.holding && !options.keepHeld && !(await this.releaseAll())) throw new OutcomeUnknown(action, "a held key or mouse button couldn't be released");
    return result;
  }

  trackStreamEvent(method: string, params: Record<string, unknown>): void {
    const kind = params["type"];
    if (method === "Input.dispatchKeyEvent" && params["key"]) {
      const key = String(params["key"]);
      if (kind === "keyDown" || kind === "rawKeyDown") this.heldKeys.set(key, { ...params });
      else if (kind === "keyUp") this.heldKeys.delete(key);
    } else if (method === "Input.dispatchMouseEvent") {
      const mouse = this.pointer;
      if ("x" in params && "y" in params) mouse.position = [Number(params["x"]), Number(params["y"])];
      if (kind === "mousePressed") mouse.held = typeof params["button"] === "string" && params["button"] ? params["button"] : "left";
      else if (kind === "mouseReleased") mouse.held = null;
    }
  }

  async pressCombo(combo: string, humanize: boolean, downOnly = false, upOnly = false): Promise<void> {
    const [modifiers, last] = parseCombo(combo);
    let bits = 0;
    const random = rng();
    const hold = () => (humanize ? random.uniform(0.05, 0.12) : 0);
    const gap = () => (humanize ? random.uniform(0.03, 0.08) : 0);
    const keyEvent = async (kind: string, key: string, code: string, keycode: number, text: string | null = null, commands: string[] | null = null) => {
      const params: Record<string, unknown> = { type: kind, key, code, windowsVirtualKeyCode: keycode, modifiers: bits };
      if (text !== null && kind === "keyDown") {
        params["text"] = text;
        params["unmodifiedText"] = text;
      }
      if (commands && commands.length > 0) params["commands"] = commands;
      if (kind === "keyDown" && text === null) params["type"] = "rawKeyDown";
      if (params["type"] === "keyDown" || params["type"] === "rawKeyDown") this.heldKeys.set(key, params);
      await this.page.send("Input.dispatchKeyEvent", params, { inputEvent: true });
      if (kind === "keyUp") this.heldKeys.delete(key);
    };
    if (!upOnly) {
      for (const modifier of modifiers) {
        const [key, code, keycode] = MODIFIER_KEYS[modifier] as readonly [string, string, number];
        bits |= MODIFIER_BITS[modifier] as number;
        await keyEvent("keyDown", key, code, keycode);
        await sleep(gap());
      }
    } else {
      for (const modifier of modifiers) bits |= MODIFIER_BITS[modifier] as number;
    }
    if (last !== null) {
      const [key, code, keycode, given] = parseKey(last);
      let text = given;
      if (bits & ((MODIFIER_BITS["Control"] as number) | (MODIFIER_BITS["Meta"] as number) | (MODIFIER_BITS["Alt"] as number))) text = null;
      else if (text !== null && bits & (MODIFIER_BITS["Shift"] as number) && pyLen(text) === 1) text = text.toUpperCase();
      const commands = editingCommands(bits, pyLen(last) === 1 ? last : key);
      if (!upOnly) await keyEvent("keyDown", key, code, keycode, text, commands);
      if (!downOnly) {
        await sleep(hold());
        await keyEvent("keyUp", key, code, keycode);
      }
    }
    if (!downOnly) {
      for (const modifier of [...modifiers].reverse()) {
        const [key, code, keycode] = MODIFIER_KEYS[modifier] as readonly [string, string, number];
        bits &= ~(MODIFIER_BITS[modifier] as number);
        await sleep(gap());
        await keyEvent("keyUp", key, code, keycode);
      }
    }
  }
}

export function installInput(): void {
  Page.makeInput = (page) => new Input(page);
}

export function inputOf(page: Page): Input {
  if (!(page.input instanceof Input)) throw new BrowseError("this tab has no input bound", null, "internal_error");
  return page.input;
}
