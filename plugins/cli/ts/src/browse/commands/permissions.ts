import type { Browser } from "../cdp/browser.ts";

export type Descriptor = { name: string; allowWithoutSanitization?: boolean };

export const PERMISSIONS: Readonly<Record<string, readonly Descriptor[]>> = {
  geolocation: [{ name: "geolocation" }],
  notifications: [{ name: "notifications" }],
  camera: [{ name: "camera" }],
  microphone: [{ name: "microphone" }],
  clipboard: [{ name: "clipboard-read" }, { name: "clipboard-write", allowWithoutSanitization: true }],
};

export async function allow(browser: Browser, origin: string | null, names: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  for (const name of names) {
    for (const permission of PERMISSIONS[name] ?? []) {
      const key = JSON.stringify(permission);
      if (seen.has(key)) continue;
      seen.add(key);
      await browser.send("Browser.setPermission", { permission, setting: "granted", origin });
    }
  }
}
