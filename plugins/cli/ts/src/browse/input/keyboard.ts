import { rng } from "../../pylib/random.ts";
import { sleep } from "../cdp/cancel.ts";
import type { Element, Page } from "../state/page.ts";
import { type KeyCommand, keyEvents, TYPING, pauseAfter } from "./human.ts";

export type HeldKeys = Map<string, Record<string, unknown>>;

export class KeyTarget {
  constructor(
    readonly page: Page,
    readonly held: HeldKeys,
  ) {}

  async execute(command: KeyCommand): Promise<void> {
    const params = command.params;
    const kind = params["type"];
    const key = String(params["key"]);
    if (kind === "keyDown" || kind === "rawKeyDown") this.held.set(key, params);
    await this.page.send(command.method, params, { inputEvent: true });
    if (kind === "keyUp") this.held.delete(key);
  }

  async focus(): Promise<void> {}

  get refocus(): boolean {
    return false;
  }

  async releaseBlind(): Promise<void> {
    await this.page.send("Input.dispatchKeyEvent", BLIND_KEY_UP, { inputEvent: true });
    this.held.delete(BLIND_HELD);
  }

  async pressSecret(down: KeyCommand): Promise<void> {
    this.held.set(BLIND_HELD, { ...BLIND_KEY_UP, type: "keyDown" });
    await this.page.send(down.method, down.params, { inputEvent: true });
  }

  async liftSecret(up: KeyCommand): Promise<void> {
    await this.page.send(up.method, up.params, { inputEvent: true });
    this.held.delete(BLIND_HELD);
  }
}

export const BLIND_HELD = "\u0000secret";
export const BLIND_KEY_UP: Readonly<Record<string, string | number>> = { type: "keyUp", key: "Unidentified", code: "", windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };

export class FocusedKeyTarget extends KeyTarget {
  constructor(
    page: Page,
    held: HeldKeys,
    readonly element: Element,
    readonly guard: (() => Promise<void>) | null = null,
  ) {
    super(page, held);
  }

  override async focus(): Promise<void> {
    await this.page.focusElement(this.element);
    if (this.guard !== null) await this.guard();
  }

  override get refocus(): boolean {
    return true;
  }
}

export class Keyboard {
  constructor(readonly target: KeyTarget) {}

  async typeText(text: string, humanize = false): Promise<void> {
    if (humanize) {
      for (const char of text) {
        await this.typeChar(char);
        await sleep(pauseAfter(char, rng()));
      }
      return;
    }
    if (this.target.refocus) await this.target.focus();
    for (const char of text) for (const command of keyEvents(char)) await this.target.execute(command);
  }

  async typeSecretChar(char: string, hold: number | null, verify: () => Promise<void>, verifyBeforeUp: () => Promise<void> = verify): Promise<void> {
    await this.target.focus();
    await verify();
    const [down, up] = keyEvents(char);
    try {
      await this.target.pressSecret(down);
      const dwell = hold === null ? rng().uniform(TYPING.keyHoldMin, TYPING.keyHoldMax) : hold;
      if (dwell > 0) await sleep(dwell);
      await verifyBeforeUp();
    } catch (error) {
      await this.target.releaseBlind().catch(() => undefined);
      throw error;
    }
    await this.target.liftSecret(up);
  }

  async typeChar(char: string, hold: number | null = null): Promise<void> {
    if (this.target.refocus) await this.target.focus();
    const [down, up] = keyEvents(char);
    await this.target.execute(down);
    const dwell = hold === null ? rng().uniform(TYPING.keyHoldMin, TYPING.keyHoldMax) : hold;
    if (dwell > 0) await sleep(dwell);
    await this.target.execute(up);
  }
}
