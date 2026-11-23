import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { failure } from "../src/browse/cdp/browser.ts";
import { Gated } from "../src/browse/daemon-errors.ts";
import { commandHelp } from "../src/browse/help.ts";
import { CommandFailed } from "../src/browse/cdp/link.ts";

function refused(method: string, command: string): Gated {
  const error = failure(method, new CommandFailed("m", { code: -32000, message: `${method} isn't allowed for the ardia command` }));
  expect(error).toBeInstanceOf(Gated);
  return (error as Gated).during(command);
}

test("a refused upload says it is a deliberate limit, what changes, and what to do now", () => {
  const error = refused("DOM.setFileInputFiles", "upload");
  expect(error.code).toBe("policy_refused");
  expect(error.exitCode).toBe(1);
  expect(error.text).toContain("`upload` isn't available yet (DOM.setFileInputFiles isn't allowed for the ardia command)");
  expect(error.text).toContain("deliberate safety limit, not a bug");
  expect(error.text).toContain("A later Ardia adds it behind its full-control setting");
  expect(error.text).toContain("Instead: ask the user to choose the file in the page");
  expect(error.text).not.toContain(": update Ardia");
});

test("download, emulation, media and screencast each name their own way around", () => {
  expect(refused("Browser.setDownloadBehavior", "download").text).toContain("Instead: `read --links <part of the link's address> --list` prints its full URL, and for a public text or JSON file `read --http --raw <that URL>` fetches it");
  expect(refused("Browser.setDownloadBehavior", "wait --download").text).toContain("Instead: ask the user to download the file");
  expect(refused("Fetch.enable", "set auth").text).toContain("Instead: ask the user to sign in in the tab");
  expect(refused("Page.startScreencast", "record restart").text).toContain("`record restart` isn't available yet");
  expect(refused("Fetch.enable", "network route").text).toContain("Instead: `network requests` lists what the page loads");
  expect(refused("Tracing.start", "trace start").text).toContain("Instead: `eval` can read the page's own `performance` timings");
  expect(refused("Browser.setPermission", "set permission").text).toContain("Instead: ask the user to allow it when the site asks");
  expect(refused("Storage.getCookies", "cdp").text).toBe(
    "`cdp` isn't allowed on this Ardia (Storage.getCookies isn't allowed for the ardia command). Updating Ardia may help; if it doesn't, do this step another way, or ask the user to do it",
  );
  expect(refused("Input.setInterceptDrags", "drag").text).toContain("`drag` isn't allowed on this Ardia");
  expect(refused("Input.setInterceptDrags", "drag").text).not.toContain("won't help");
  expect(refused("Fetch.enable", "constructor").text).toContain("isn't allowed on this Ardia");
  expect(refused("Emulation.setEmulatedMedia", "set media").text).toContain("Instead: read the page as it is");
  expect(refused("Emulation.setGeolocationOverride", "set geo").text).toContain("Instead: use the site's own location field");
  expect(refused("Emulation.setUserAgentOverride", "set device").text).toContain("`set viewport <w> <h>`");
  expect(refused("Page.startScreencast", "record start").text).toContain("Instead: take a `screenshot`");
  expect(refused("Page.startScreencast", "stream enable").text).toContain("Instead: take a `screenshot`");
  expect(refused("Network.getCookies", "cookies get").text).toContain("Instead: `eval document.cookie`");
  const unnamed = failure("Overlay.enable", new CommandFailed("m", { code: -32000, message: "Overlay.enable isn't allowed for the ardia command" })) as Gated;
  expect(unnamed.text).toContain("Overlay.enable isn't allowed on this Ardia");
  expect(unnamed.text).toContain("Updating Ardia may help");
});

test("clipboard copy and paste, refused with a reason, still get the not-yet message and keep the reason", () => {
  const error = failure("Input.dispatchKeyEvent", new CommandFailed("m", { code: -32000, message: "Input.dispatchKeyEvent with those editing commands isn't allowed for the ardia command" })) as Gated;
  const copy = error.during("clipboard copy");
  expect(copy.text).toContain("`clipboard copy` isn't available yet (Input.dispatchKeyEvent with those editing commands isn't allowed for the ardia command)");
  expect(copy.text).toContain("Instead: `fill` or `type` puts text in, and `get value` (a field) or `get text` reads it out");
  expect((copy.data as Record<string, unknown>)["reason"]).toBe("with those editing commands");
});

test("a refusal with a reason about the tab keeps its own message", () => {
  const error = failure("Emulation.setDeviceMetricsOverride", new CommandFailed("m", { code: -32000, message: "Emulation.setDeviceMetricsOverride on a tab that isn't off-screen isn't allowed for the ardia command" })) as Gated;
  expect(error.text).toContain("which Ardia allows for the ardia command, but not on a tab that isn't off-screen");
  expect(error.text).not.toContain("isn't available yet");
});

test("the help marks these commands not available yet instead of blaming an older Ardia", () => {
  const overview = commandHelp(undefined);
  expect(overview).not.toContain("Older Ardia");
  expect(overview).toContain("Not available yet: cookies, state save (and state load of a file with cookies), set device|geo|offline|\nheaders|credentials|media|permission, network route");
  expect(overview).toContain("set viewport works on a tab this session opened and never showed");
  expect(commandHelp("network")).not.toContain("update Ardia");
  expect(commandHelp("cdp")).not.toContain("Storage.getCookies");
  expect(commandHelp("set")).toContain("Browser.setPermission, which no\nreleased Ardia allows yet");
  expect(commandHelp("upload")).toContain("Not available yet");
  expect(commandHelp("download")).toContain("Not available yet");
  expect(commandHelp("record")).toContain("Not available yet");
  expect(commandHelp("set")).not.toContain("update it");
});
