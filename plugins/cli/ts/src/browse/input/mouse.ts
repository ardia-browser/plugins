import { hypot } from "../../pylib/math.ts";
import { rng } from "../../pylib/random.ts";
import { type CdpResult } from "../cdp/browser.ts";
import { sleep } from "../cdp/cancel.ts";
import { OutcomeUnknown } from "../daemon-errors.ts";
import type { Page } from "../state/page.ts";
import { nativeMouseClick } from "../state/tabtools.ts";
import { monotonic } from "../state/wait.ts";
import { bezierPoint, BUTTON_MASK, controlPoints, CubicBezier, MOUSE, minimumJerk, moveDuration, PRESSED_FORCE, roundCoordinate, SCROLL, tremorSigma } from "./human.ts";

export const MOUSE_TIMEOUT = 60;

export interface DragHandoff {
  data: unknown;
  over(x: number, y: number): Promise<void>;
  moved(x: number, y: number): Promise<void>;
  release(x: number, y: number): Promise<void>;
}

export class Mouse {
  position: [number, number] = [0, 0];
  pressedButton: string | null = null;
  held: string | null = null;
  interception: DragHandoff | null = null;

  constructor(readonly page: Page) {}

  async move(x: number, y: number, humanize = false): Promise<void> {
    if (humanize) await this.moveHumanized(x, y);
    else await this.dispatchMove(x, y);
  }

  async click(x: number, y: number, button = "left", clickCount = 1, humanize = false, allowNative = true): Promise<void> {
    if (humanize) {
      await this.clickHumanized(x, y, button, clickCount);
      return;
    }
    if (allowNative && this.interception === null && this.pressedButton === null && (clickCount === 1 || clickCount === 2)) {
      const rx = roundCoordinate(x);
      const ry = roundCoordinate(y);
      if (await nativeMouseClick(this.page, rx, ry, button, clickCount)) {
        this.position = [x, y];
        return;
      }
    }
    await this.dispatchMove(x, y);
    await this.dispatchButton("mousePressed", button, clickCount);
    await this.dispatchButton("mouseReleased", button, clickCount);
  }

  async down(button = "left"): Promise<void> {
    await this.dispatchButton("mousePressed", button);
  }

  async up(button = "left"): Promise<void> {
    await this.dispatchButton("mouseReleased", button);
  }

  async drag(startX: number, startY: number, endX: number, endY: number, humanize = false): Promise<void> {
    if (humanize) {
      await this.dragHumanized(startX, startY, endX, endY);
      return;
    }
    await this.dispatchMove(startX, startY);
    await this.dispatchButton("mousePressed", "left");
    await this.dispatchMove(endX, endY);
    await this.dispatchButton("mouseReleased", "left");
  }

  private async moveHumanized(x: number, y: number): Promise<void> {
    const start = this.position;
    const target: [number, number] = [x, y];
    const distance = hypot(x - start[0], y - start[1]);
    if (distance < 1.0) {
      await this.dispatchMove(x, y);
      return;
    }
    const random = rng();
    const duration = moveDuration(distance);
    if (distance > MOUSE.overshootSpeedThreshold && random.random() < MOUSE.overshootProbability) {
      const fraction = random.uniform(MOUSE.overshootDistanceMin, MOUSE.overshootDistanceMax);
      const beyond: [number, number] = [x + (x - start[0]) * fraction, y + (y - start[1]) * fraction];
      await this.path(start, beyond, duration * 0.85);
      await this.path(beyond, target, duration * 0.15);
    } else {
      await this.path(start, target, duration);
    }
    await this.dispatchMove(x, y);
  }

  private async path(start: readonly [number, number], end: readonly [number, number], duration: number): Promise<void> {
    const random = rng();
    const [near, far] = controlPoints(start, end, random);
    let began = monotonic();
    let previous: [number, number, number] = [start[0], start[1], began];
    for (;;) {
      const now = monotonic();
      const elapsed = now - began;
      if (elapsed >= duration) break;
      let [x, y] = bezierPoint(minimumJerk(elapsed / duration), start, near, far, end);
      const sigma = tremorSigma(x, y, now, previous);
      x += random.gauss(0, sigma);
      y += random.gauss(0, sigma);
      await this.dispatchMove(x, y);
      previous = [x, y, now];
      await sleep(Math.max(0.001, MOUSE.frameInterval + random.uniform(-MOUSE.frameIntervalVariance, MOUSE.frameIntervalVariance)));
      if (random.random() < MOUSE.microPauseProbability) {
        const pause = random.uniform(MOUSE.microPauseMin, MOUSE.microPauseMax);
        await sleep(pause);
        began += pause;
      }
    }
  }

  private async clickHumanized(x: number, y: number, button: string, clickCount: number): Promise<void> {
    await this.moveHumanized(x, y);
    await sleep(rng().uniform(MOUSE.preClickPauseMin, MOUSE.preClickPauseMax));
    for (let number = 1; number <= clickCount; number += 1) {
      await this.dispatchButton("mousePressed", button, number);
      await sleep(rng().uniform(MOUSE.clickHoldMin, MOUSE.clickHoldMax));
      await this.dispatchButton("mouseReleased", button, number);
      if (number < clickCount) await sleep(rng().uniform(MOUSE.doubleClickIntervalMin, MOUSE.doubleClickIntervalMax));
    }
  }

  private async dragHumanized(startX: number, startY: number, endX: number, endY: number): Promise<void> {
    await this.moveHumanized(startX, startY);
    await this.dispatchButton("mousePressed", "left");
    await sleep(rng().uniform(MOUSE.dragStartPauseMin, MOUSE.dragStartPauseMax));
    const start = this.position;
    await this.path(start, [endX, endY], moveDuration(hypot(endX - start[0], endY - start[1])));
    await this.dispatchMove(endX, endY);
    await sleep(rng().uniform(MOUSE.dragEndPauseMin, MOUSE.dragEndPauseMax));
    await this.dispatchButton("mouseReleased", "left");
  }

  private async send(params: CdpResult): Promise<void> {
    try {
      await this.page.send("Input.dispatchMouseEvent", params, { inputEvent: true, timeout: MOUSE_TIMEOUT });
    } catch (error) {
      if (error instanceof OutcomeUnknown && error.text.includes("didn't answer")) {
        throw new OutcomeUnknown("the mouse input", "Ardia didn't answer an input event in time");
      }
      throw error;
    }
  }

  async dispatchMove(x: number, y: number): Promise<void> {
    const interception = this.pressedButton !== null ? this.interception : null;
    if (interception !== null && interception.data !== null) {
      await interception.over(x, y);
      this.position = [x, y];
      return;
    }
    const params: CdpResult = { type: "mouseMoved", x: roundCoordinate(x), y: roundCoordinate(y) };
    const pressed = this.pressedButton;
    if (pressed !== null) Object.assign(params, { button: pressed, buttons: BUTTON_MASK[pressed], force: PRESSED_FORCE });
    await this.send(params);
    this.position = [x, y];
    if (interception !== null) await interception.moved(x, y);
  }

  async dispatchButton(kind: string, button: string, clickCount = 1): Promise<void> {
    const pressed = kind === "mousePressed";
    if (!pressed && this.interception !== null) await this.interception.release(this.position[0], this.position[1]);
    if (pressed) this.held = button;
    const params: CdpResult = { type: kind, x: roundCoordinate(this.position[0]), y: roundCoordinate(this.position[1]), button, clickCount };
    if (pressed) Object.assign(params, { buttons: BUTTON_MASK[button], force: PRESSED_FORCE });
    await this.send(params);
    this.pressedButton = pressed ? button : null;
    if (!pressed) this.held = null;
  }
}

export type Wheel = (dx: number, dy: number) => Promise<void>;

export async function humanScroll(wheel: Wheel, distance: number, vertical: boolean, direction: number): Promise<void> {
  const random = rng();
  const overshoot = random.random() < SCROLL.overshootProbability ? random.uniform(SCROLL.overshootFactorMin, SCROLL.overshootFactorMax) : 1.0;
  const effective = distance * overshoot;
  const duration = Math.min(random.uniform(SCROLL.minDuration, SCROLL.maxDuration) * (1 + 0.2 * (effective / 1000)), 3.0);
  const step = async (delta: number, sign: number) => {
    const amount = Math.trunc(delta * sign);
    await wheel(vertical ? 0 : amount, vertical ? amount : 0);
  };
  const curve = new CubicBezier(...SCROLL.bezierPoints);
  let began = monotonic();
  let scrolled = 0.0;
  for (;;) {
    const elapsed = monotonic() - began;
    if (elapsed >= duration) break;
    const delta = Math.max(effective * curve.solve(elapsed / duration) - scrolled + random.randint(-SCROLL.deltaJitter, SCROLL.deltaJitter), 0);
    if (delta >= 1) {
      await step(delta, direction);
      scrolled += delta;
    }
    await sleep(SCROLL.frameInterval + random.uniform(-0.002, 0.002));
    if (random.random() < SCROLL.microPauseProbability) {
      const pause = random.uniform(SCROLL.microPauseMin, SCROLL.microPauseMax);
      await sleep(pause);
      began += pause;
    }
  }
  if (effective > distance && scrolled > distance) {
    await sleep(random.uniform(0.1, 0.2));
    const remaining = scrolled - distance;
    let corrected = 0.0;
    const pace = (remaining * 0.15) / SCROLL.frameInterval;
    let velocity = random.uniform(Math.max(200, pace), Math.max(400, pace * 1.5));
    while (corrected < remaining) {
      const delta = Math.min(velocity * SCROLL.frameInterval, remaining - corrected);
      await step(delta, -direction);
      corrected += delta;
      velocity *= 0.85;
      await sleep(SCROLL.frameInterval);
    }
  }
}
