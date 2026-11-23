import { didYouMean } from "./pylib/close.ts";

export const EVENTS = [
  "window.opened",
  "window.closed",
  "window.focused",
  "tab.opened",
  "tab.closed",
  "tab.activated",
  "tab.navigated",
  "settings.changed",
  "app.launched",
  "app.quitting",
  "app.activated",
  "app.deactivated",
  "tab.idle",
  "tab.resumed",
  "media.started",
  "media.stopped",
  "tab.crashed",
  "notification.shown",
  "peek.opened",
  "peek.closed",
  "littleArdia.opened",
  "split.created",
  "split.closed",
  "pin.added",
  "pin.removed",
  "tab.moved",
  "profile.switched",
  "system.sleep",
  "system.wake",
  "user.idle",
  "user.active",
  "page.error",
] as const;
export const NAMED_ONLY_EVENTS: readonly string[] = ["notification.shown", "app.activated", "app.deactivated", "system.sleep", "system.wake", "user.idle", "user.active"];
export const TAB_IDLE_EVENTS: readonly string[] = ["tab.idle", "tab.resumed"];
export const USER_IDLE_EVENTS: readonly string[] = ["user.idle", "user.active"];
export const DECIDE_EVENTS: readonly string[] = ["tab.opening", "link.opening", "download.deciding", "permission.requested"];

export class EventNameError extends Error {}

export function checkEvents(names: readonly string[]): string[] {
  const known: readonly string[] = EVENTS;
  for (const name of names) {
    if (name !== "*" && !known.includes(name)) throw new EventNameError(`unknown event ${name}${didYouMean(name, known)}; events: ${known.join(", ")}`);
  }
  return [...names];
}

export function isIdleEvent(name: string): boolean {
  return TAB_IDLE_EVENTS.includes(name) || USER_IDLE_EVENTS.includes(name);
}
