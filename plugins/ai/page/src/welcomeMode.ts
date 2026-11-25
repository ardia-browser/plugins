import type { Values } from "./api";

export function shownMode(saved: Values, chosen: string | null): string {
  return chosen ?? (typeof saved.mode === "string" ? saved.mode : "browser");
}
