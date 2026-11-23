import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { failure } from "../src/browse/cdp/browser.ts";
import { Gated } from "../src/browse/daemon-errors.ts";
import { commandHelp } from "../src/browse/help.ts";
import { CommandFailed } from "../src/browse/cdp/link.ts";
import { clipHeaders } from "../src/browse/state/records.ts";

function refused(method: string, command: string): Gated {
  const error = failure(method, new CommandFailed("m", { code: -32000, message: `ardia: ${method} isn't allowed for the ardia command` }));
  expect(error).toBeInstanceOf(Gated);
  return (error as Gated).during(command);
}

test("a refused upload says which Ardia allows it, to update, and what to do until then", () => {
  const error = refused("DOM.setFileInputFiles", "upload");
  expect(error.code).toBe("policy_refused");
  expect(error.exitCode).toBe(1);
  expect(error.text).toContain("`upload` needs Ardia 0.2.49 or later (DOM.setFileInputFiles isn't allowed for the ardia command)");
  expect(error.text).toContain("so update Ardia and run it again");
  expect(error.text).toContain("Until then: ask the user to choose the file in the page");
  expect(error.text).not.toContain("deliberate");
});

test("download, emulation, media and screencast each name their own way around", () => {
  expect(refused("Browser.setDownloadBehavior", "download").text).toContain("Until then: `read --links <part of the link's address> --list` prints its full URL, and for a public text or JSON file `read --http --raw <that URL>` fetches it");
  expect(refused("Browser.setDownloadBehavior", "wait --download").text).toContain("Until then: ask the user to download the file");
  expect(refused("Fetch.enable", "set auth").text).toContain("Until then: ask the user to sign in in the tab");
  expect(refused("Page.startScreencast", "record restart").text).toContain("`record restart` needs Ardia 0.2.49 or later");
  expect(refused("Fetch.enable", "network route").text).toContain("Until then: `network requests` lists what the page loads");
  expect(refused("Tracing.start", "trace start").text).toContain("Until then: `eval` can read the page's own `performance` timings");
  expect(refused("Browser.setPermission", "set permission").text).toContain("Until then: ask the user to allow it when the site asks");
  expect(refused("Storage.getCookies", "cdp").text).toBe(
    "`cdp` isn't allowed on this Ardia (Storage.getCookies isn't allowed for the ardia command). Its engine keeps the ardia command to a short list of DevTools methods, and Ardia 0.2.49 or later allows them all: update Ardia, or do this step another way, or ask the user to do it",
  );
  expect(refused("Input.setInterceptDrags", "drag").text).toContain("`drag` isn't allowed on this Ardia");
  expect(refused("Input.setInterceptDrags", "drag").text).not.toContain("won't help");
  expect(refused("Fetch.enable", "constructor").text).toContain("isn't allowed on this Ardia");
  expect(refused("Emulation.setEmulatedMedia", "set media").text).toContain("Until then: read the page as it is");
  expect(refused("Emulation.setGeolocationOverride", "set geo").text).toContain("Until then: use the site's own location field");
  expect(refused("Emulation.setUserAgentOverride", "set device").text).toContain("`set viewport <w> <h>`");
  expect(refused("Page.startScreencast", "record start").text).toContain("Until then: take a `screenshot`");
  expect(refused("Page.startScreencast", "stream enable").text).toContain("Until then: take a `screenshot`");
  expect(refused("Network.getCookies", "cookies get").text).toContain("Until then: `eval document.cookie`");
  const unnamed = failure("Overlay.enable", new CommandFailed("m", { code: -32000, message: "ardia: Overlay.enable isn't allowed for the ardia command" })) as Gated;
  expect(unnamed.text).toContain("Overlay.enable isn't allowed on this Ardia");
  expect(unnamed.text).toContain("Ardia 0.2.49 or later allows them all: update Ardia");
});

test("clipboard copy and paste, refused with a reason, still get the not-yet message and keep the reason", () => {
  const error = failure("Input.dispatchKeyEvent", new CommandFailed("m", { code: -32000, message: "ardia: Input.dispatchKeyEvent with those editing commands isn't allowed for the ardia command" })) as Gated;
  const copy = error.during("clipboard copy");
  expect(copy.text).toContain("`clipboard copy` needs Ardia 0.2.49 or later (Input.dispatchKeyEvent with those editing commands isn't allowed for the ardia command)");
  expect(copy.text).toContain("Until then: `fill` or `type` puts text in, and `get value` (a field) or `get text` reads it out");
  expect((copy.data as Record<string, unknown>)["reason"]).toBe("with those editing commands");
});

test("a refusal with a reason about the tab keeps its own message", () => {
  const error = failure("Emulation.setDeviceMetricsOverride", new CommandFailed("m", { code: -32000, message: "ardia: Emulation.setDeviceMetricsOverride on a tab that isn't off-screen isn't allowed for the ardia command" })) as Gated;
  expect(error.text).toContain("which this Ardia allows for the ardia command, but not on a tab that isn't off-screen");
  expect(error.text).toContain("Ardia 0.2.49 or later has no such limit");
  expect(error.text).not.toContain("needs Ardia");
});

test("the help says these commands need Ardia 0.2.49 or later, which an update fixes", () => {
  const overview = commandHelp(undefined);
  expect(overview).toContain("Need Ardia 0.2.49 or later: cookies, state save (and state load of a file with cookies), set device|geo|\noffline|headers|credentials|media|permission, network route");
  expect(overview).toContain("updating Ardia fixes it");
  expect(overview).toContain("set viewport works on a tab this session opened and never showed");
  expect(overview).not.toContain("Not available yet");
  expect(commandHelp("network")).toContain("route needs Fetch.enable: Ardia 0.2.49 or later");
  expect(commandHelp("cdp")).not.toContain("Storage.getCookies");
  expect(commandHelp("set")).toContain("Browser.setPermission: Ardia\n0.2.49 or later");
  for (const name of ["upload", "download", "record", "stream", "set"]) {
    expect(commandHelp(name)).toContain("Ardia 0.2.49");
    expect(commandHelp(name)).not.toContain("Not available yet");
    expect(commandHelp(name)).not.toContain("on purpose");
  }
});

test("only the engine's own refusal reply counts, never the phrase echoed inside another error", () => {
  const echoed = failure("Browser.setPermission", new CommandFailed("m", { code: -32602, message: "Invalid parameters: setting 'x isn't allowed for the ardia command'" }));
  expect(echoed).not.toBeInstanceOf(Gated);
  const otherCode = failure("DOM.setFileInputFiles", new CommandFailed("m", { code: -32602, message: "ardia: DOM.setFileInputFiles isn't allowed for the ardia command" }));
  expect(otherCode).not.toBeInstanceOf(Gated);
  const otherMethod = failure("DOM.setFileInputFiles", new CommandFailed("m", { code: -32601, message: "ardia: DOM.setFileInputFilesX isn't allowed for the ardia command" }));
  expect(otherMethod).not.toBeInstanceOf(Gated);
  expect(failure("Fetch.enable", new CommandFailed("m", { code: -32601, message: "ardia: Fetch.enable isn't allowed for the ardia command" }))).toBeInstanceOf(Gated);
});

test("recorded headers leave credentials out", () => {
  const kept = clipHeaders({ Accept: "*/*", Cookie: "sid=1", authorization: "Bearer x", "Set-Cookie": "a=b", "Proxy-Authorization": "Basic y", "X-Trace": "t" });
  expect(kept).toEqual({ Accept: "*/*", "X-Trace": "t" });
});
