import { rng } from "../../pylib/random.ts";
import { BrowseError } from "../daemon-errors.ts";
import { inputOf } from "../input/input.ts";
import { frameOffset } from "../state/frames.ts";
import type { Element, Page } from "../state/page.ts";
import { expectInput, overFrame, rect, viewport } from "./common.ts";
import { scrollWheel } from "./pointer.ts";

export const SCROLL_DEFAULT = 300;

export async function scroll(page: Page, given: string | null, amount: number, humanize: boolean, element: Element | null = null): Promise<void> {
  const direction = (given || "down").toLowerCase();
  if (!["up", "down", "left", "right"].includes(direction)) throw new BrowseError(`Unknown scroll direction: ${direction} (up, down, left or right)`);
  const vertical = direction === "up" || direction === "down";
  const distance = direction === "down" || direction === "right" ? amount : -amount;
  let point: [number, number];
  let frame: string | null = null;
  const input = inputOf(page);
  if (element !== null) {
    const r = await rect(page, element);
    const [ox, oy] = await frameOffset(page, element.frame);
    const x = ox + r.x + r.width * rng().uniform(0.35, 0.65);
    point = [x, oy + r.y + r.height * rng().uniform(0.35, 0.65)];
    frame = element.frame;
  } else {
    const vp = await viewport(page);
    let [x, y] = input.pointer.position;
    if (!(8 <= x && x <= vp.width - 8 && 8 <= y && y <= vp.height - 8)) {
      x = vp.width * rng().uniform(0.35, 0.65);
      y = vp.height * rng().uniform(0.35, 0.65);
    }
    point = [x, y];
  }
  const landedInside = frame === null && distance !== 0 && (await overFrame(page, point[0], point[1]));
  let wheeled = false;
  await expectInput(
    page,
    frame,
    () =>
      input.gesture(
        "scroll",
        async () => {
          wheeled = await scrollWheel(page, distance, vertical, humanize, point, frame, element);
        },
        { allowHidden: true },
      ),
    () => (distance === 0 || landedInside || !wheeled ? {} : { wheel: 1 }),
    "The scroll",
  );
}
