import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 14;
const FIXTURE = pathToFileURL(path.join(import.meta.dir, "..", "fixtures", "browse", "carousel-modal.html")).href;

let root = "";
let chrome: ChildProcess | null = null;

function answers(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: PORT, path: "/json/version", timeout: 500, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => request.destroy());
  });
}

function browse(...args: string[]): { status: number | null; out: string; err: string } {
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off", AGENT_BROWSER_CONTENT_BOUNDARIES: "0" };
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "modals", ...args], { env, cwd: root, encoding: "utf8", timeout: 45_000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

function clickSlideAfter(setup: string): { click: ReturnType<typeof browse>; clicked: string } {
  expect(browse("open", FIXTURE).status).toBe(0);
  expect(browse("eval", "--main-world", setup).status).toBe(0);
  const click = browse("click", "#s2");
  return { click, clicked: browse("eval", "--main-world", "state.clicked.join()").out.trim() };
}

describe.skipIf(!CHROME)("a DOM click behind a role=dialog without aria-modal, against headless Chrome (ardia#1965)", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-modals-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await answers())) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await answers()).toBe(true);
  }, 60_000);

  afterAll(() => {
    if (root) browse("close");
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("a dialog that marks the rest of the page aria-hidden holds back the click and is named", () => {
    const { click, clicked } = clickSlideAfter("document.getElementById('app').setAttribute('aria-hidden', 'true'), reveal('profile')");
    expect(click.status).toBe(1);
    expect(click.err).toContain('modal dialog "Edit profile"');
    expect(clicked).toBe('""');
  });

  test("a dialog that makes the rest of the page inert holds back the click", () => {
    const { click, clicked } = clickSlideAfter("document.getElementById('app').inert = true, reveal('profile')");
    expect(click.status).toBe(1);
    expect(click.err).toContain('modal dialog "Edit profile"');
    expect(clicked).toBe('""');
  });

  test("a slide its own carousel hides from screen readers still gets a DOM click beside the chat dialog", () => {
    const { click, clicked } = clickSlideAfter("document.getElementById('s2').setAttribute('aria-hidden', 'true'), 'ok'");
    expect(click.status).toBe(0);
    expect(clicked).toBe('"s2"');
  });
});
