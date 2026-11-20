import { pyFloat, pyInt } from "../../pylib/str.ts";
import { plainParams, pyLoads } from "../cdp/params.ts";
import { BrowseError, Gated, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { appCall, appTabMap, ControlRefused } from "../state/apptabs.ts";
import type { Page } from "../state/page.ts";
import { refuseOnBorrowed } from "./borrowed.ts";
import { allow, PERMISSIONS } from "./permissions.ts";
import { engineOffscreen, leaveOffscreen } from "./core.ts";
import type { Ctx } from "./ctx.ts";
import { canonical, register, unsupported } from "./index.ts";
import { need, parse } from "./parse.ts";

export const OFFSCREEN_TIMEOUT = 10.0;
export const NEEDS_HIDDEN_TAB =
  "`set viewport` works on a tab this session opened that has never been shown: Ardia takes it off-screen first, so " +
  "an emulated page is never on screen";
export const OPEN_ONE = "Open one with `ardia browse open <url>` (without --show) and set its viewport there";
export const SET_USAGE = "set viewport|device|geo|offline|headers|credentials|media ...";

type Device = [number, number, number, boolean, string | null];

export const DEVICES: Readonly<Record<string, Device>> = {
  "iphone 14": [390, 844, 3, true, "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"],
  "iphone 15 pro": [393, 852, 3, true, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"],
  "iphone 12": [390, 844, 3, true, "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1"],
  "pixel 7": [412, 915, 2.625, true, "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"],
  "ipad pro 11": [834, 1194, 2, true, "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"],
  desktop: [1280, 800, 1, false, null],
};

export const PROMPT_NOTE =
  "granted ahead of any prompt; a permission prompt already on screen isn't answered by this (Ardia doesn't let the ardia command answer one yet), " +
  "so set it before the page asks";

export type CredentialsHook = (ctx: Ctx, page: Page, username: string, password: string) => Promise<void>;
export const setHooks: { credentials: CredentialsHook | null } = { credentials: null };

async function overridden(page: Page, method: string, params: Record<string, unknown>): Promise<void> {
  await page.send(method, params);
  page.overrides.set(method, params);
}

function int(text: string): number {
  return Number(pyInt(text));
}

async function goOffscreen(ctx: Ctx, page: Page): Promise<boolean> {
  const state = ctx.state;
  if (state.endpoint === null || state.endpoint.explicit) return false;
  if (await engineOffscreen(state, page.targetId)) return true;
  const appTab = (await appTabMap(state)).get(page.targetId);
  if (!appTab) throw new BrowseError(`${NEEDS_HIDDEN_TAB}. Ardia doesn't list this session's tab. ${OPEN_ONE}`, null, "viewport_needs_hidden_tab");
  try {
    await appCall(state, "offscreen", { tab: appTab }, OFFSCREEN_TIMEOUT);
  } catch (error) {
    if (!(error instanceof ControlRefused)) throw error;
    if (error.code === "unknown_method") throw new BrowseError("This Ardia can't take a tab off-screen for a viewport yet; update Ardia", null, "viewport_unsupported");
    if (["unreachable", "timeout", "too_long", "bad_reply"].includes(error.code)) {
      throw new BrowseError(`Couldn't ask Ardia to take the tab off-screen (${error.message})`, null, "viewport_unsupported");
    }
    throw new BrowseError(`${NEEDS_HIDDEN_TAB}. ${error.message} ${OPEN_ONE}`, null, "viewport_needs_hidden_tab");
  }
  state.setOffscreen(page.targetId, true);
  state.appTabs.delete(page.targetId);
  return true;
}

function originOf(page: Page): string | null {
  return (page.mainFrame === null ? undefined : page.frames.get(page.mainFrame)?.origin) || null;
}

async function setPermission(ctx: Ctx, page: Page, args: string[]): Promise<Result> {
  need(args, 2, "set permission geolocation|notifications|camera|microphone|clipboard [more …]");
  const names = args.slice(1).flatMap((part) => part.split(",")).filter((part) => part);
  const unknown = names.filter((name) => !Object.hasOwn(PERMISSIONS, name));
  if (unknown.length > 0) throw new Usage(`Unknown permission: ${unknown.join(", ")} (${Object.keys(PERMISSIONS).join(", ")})`);
  const origin = originOf(page);
  if (!origin || !/^https?:\/\//u.test(origin)) {
    throw new BrowseError("Permissions are granted to the tab's web origin, and this tab isn't on a web page yet; `open <url>` first", null, "not_a_web_page");
  }
  await allow(ctx.state.browser as NonNullable<typeof ctx.state.browser>, origin, names);
  flag("permission_granted", true);
  return new Result({ origin, granted: names }, `✓ ${names.join(", ")} allowed for ${origin}: ${PROMPT_NOTE}`);
}

export async function cmdSet(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, SET_USAGE);
  const setting = canonical(args[0] as string);
  const page = await ctx.state.page();
  refuseOnBorrowed(ctx, page, `change the ${setting} of`);
  try {
    if (setting === "viewport") {
      if (args.length === 2 && (args[1] === "reset" || args[1] === "off")) {
        if (await engineOffscreen(ctx.state, page.targetId)) {
          const fresh = await leaveOffscreen(ctx, page);
          const tab = ctx.state.leftOffscreen;
          ctx.state.leftOffscreen = null;
          return new Result({ reset: true, tabId: tab, url: fresh.url }, `✓ Viewport reset: the page was reloaded in a new background tab [${tab}]`);
        }
        try {
          await page.send("Emulation.clearDeviceMetricsOverride");
        } catch (error) {
          if (!(error instanceof BrowseError)) throw error;
        }
        page.overrides.delete("Emulation.setDeviceMetricsOverride");
        ctx.state.leases.delete("emulation");
        return new Result({ reset: true }, "✓ Viewport reset");
      }
      need(args, 3, "set viewport <w> <h> [scale] | reset");
      const width = int(args[1] as string);
      const height = int(args[2] as string);
      const scale = args.length > 3 ? pyFloat(args[3] as string) : 1.0;
      const offscreen = await goOffscreen(ctx, page);
      await overridden(page, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
      if (!offscreen) ctx.state.leases.add("emulation");
      flag("viewport_set", true);
      return new Result({ width, height, deviceScaleFactor: scale, mobile: false });
    }
    if (setting === "device") {
      need(args, 2, "set device <name>");
      const wanted = args.slice(1).join(" ");
      const device = DEVICES[wanted.toLowerCase()];
      if (device === undefined || !Object.hasOwn(DEVICES, wanted.toLowerCase())) throw new BrowseError(`Unknown device: ${wanted} (${Object.keys(DEVICES).sort().join(", ")})`);
      const [width, height, scale, mobile, agent] = device;
      await overridden(page, "Emulation.setTouchEmulationEnabled", { enabled: mobile });
      await overridden(page, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
      if (agent) await overridden(page, "Emulation.setUserAgentOverride", { userAgent: agent });
      ctx.state.leases.add("emulation");
      return new Result({ device: wanted, width, height });
    }
    if (setting === "geo") {
      need(args, 3, "set geo <lat> <lng>");
      const latitude = pyFloat(args[1] as string);
      const longitude = pyFloat(args[2] as string);
      await overridden(page, "Emulation.setGeolocationOverride", { latitude, longitude, accuracy: 10 });
      ctx.state.leases.add("emulation");
      return new Result({ latitude, longitude });
    }
    if (setting === "offline") {
      const offline = ["on", "true", "1"].includes((args[1] ?? "on").toLowerCase());
      await page.enableNetwork();
      await overridden(page, "Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      ctx.state.leases.add("emulation");
      return new Result({ offline });
    }
    if (setting === "headers") {
      need(args, 2, "set headers <json>");
      const parsed = pyLoads(args.slice(1).join(" "));
      const headers = plainParams(parsed);
      await page.enableNetwork();
      await overridden(page, "Network.setExtraHTTPHeaders", { headers });
      ctx.state.leases.add("emulation");
      const names = parsed instanceof Map ? [...parsed.keys()] : Array.isArray(parsed) ? parsed.map(String) : [];
      return new Result({ headers: names.sort() });
    }
    if (setting === "credentials" || setting === "auth") {
      need(args, 3, "set credentials <user> <pass>");
      if (setHooks.credentials === null) throw unsupported("`set credentials`");
      await setHooks.credentials(ctx, page, args[1] as string, args[2] as string);
      return new Result({ username: args[1] });
    }
    if (setting === "media") {
      const features: Record<string, string>[] = [];
      const scheme = args.slice(1).find((value) => ["dark", "light", "no-preference"].includes(value));
      if (scheme) features.push({ name: "prefers-color-scheme", value: scheme });
      if (args.slice(1).includes("reduced-motion")) features.push({ name: "prefers-reduced-motion", value: "reduce" });
      await overridden(page, "Emulation.setEmulatedMedia", { features });
      ctx.state.leases.add("emulation");
      return new Result({ features });
    }
    if (setting === "permission" || setting === "permissions") return await setPermission(ctx, page, args);
  } catch (error) {
    if (error instanceof Gated) throw error.during(`set ${setting}`, (error.data as Record<string, unknown> | null)?.["detail"] as string | null | undefined);
    throw error;
  }
  throw new Usage(`Unknown setting: ${setting}`);
}

register("set", cmdSet);
