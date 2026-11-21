import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 15;
const PAGE = `<!doctype html><meta charset="utf-8"><title>guesses</title>
<p id="intro">Hello agents</p>
<a id="lnk" href="https://example.com/a" data-kind="plain">A</a>
<a href="https://example.com/docs/b">B</a>
<input id="name" aria-label="Name">
<button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
<p id="out"></p>
<label><input type="checkbox" class="mid" aria-label="No middle name">one</label>
<label><input type="checkbox" class="mid" aria-label="No middle name">two</label>
<button id="archived" onclick="document.getElementById('out').textContent='archived'">Archived · 1</button>
<nav><a href="https://example.com/nav-only">N</a></nav>
<button class="twin">Twin · 2</button><button class="twin">Twin · 2</button>
<button class="case">MIXED 4</button><button class="case">Mixed 4</button><button class="case">MIXED 4</button>
<input id="password" type="password" aria-label="Password">`;

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
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off" };
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "guesses", ...args], { env, cwd: root, encoding: "utf8", timeout: 45_000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

describe.skipIf(!CHROME)("guessed commands and flags against headless Chrome", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-guessed-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await answers())) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await answers()).toBe(true);
    expect(browse("open", `data:text/html,${encodeURIComponent(PAGE)}`).status).toBe(0);
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

  test("get attribute works as get attr, and get takes -s/--selector", () => {
    expect(browse("get", "attribute", "#lnk", "data-kind").out.trim()).toBe("plain");
    expect(browse("get", "attr", "-s", "#lnk", "data-kind").out.trim()).toBe("plain");
    expect(browse("get", "text", "--selector", "#intro").out.trim()).toBe("Hello agents");
  });

  test("click and fill take -s/--selector", () => {
    expect(browse("click", "-s", "#go").status).toBe(0);
    expect(browse("get", "text", "#out").out.trim()).toBe("clicked");
    expect(browse("fill", "--selector", "#name", "Ana Ruiz").status).toBe(0);
    expect(browse("get", "value", "#name").out.trim()).toBe("Ana Ruiz");
  });

  test("screenshot takes -s/--selector for the element", () => {
    const shot = path.join(root, "intro.png");
    const done = browse("screenshot", "-s", "#intro", shot);
    expect(done.status).toBe(0);
    expect(fs.statSync(shot).size).toBeGreaterThan(0);
  });

  test("links lists the matching links, every link without a pattern", () => {
    const docs = browse("links", "docs");
    expect(docs.status).toBe(0);
    expect(docs.out).toContain("https://example.com/docs/b");
    expect(docs.out).not.toContain("https://example.com/a\n");
    const all = browse("links");
    expect(all.out).toContain("https://example.com/a");
    expect(all.out).toContain("https://example.com/docs/b");
  });

  test("find role … --nth picks one of several matches, from 0", () => {
    const ambiguous = browse("find", "role", "checkbox", "check", "--name", "No middle name");
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.err).toContain("--nth <n>, from 0");
    expect(browse("find", "role", "checkbox", "check", "--name", "No middle name", "--nth", "1").status).toBe(0);
    expect(browse("eval", "[...document.querySelectorAll('.mid')].map((box) => box.checked).join(',')").out.trim()).toBe('"false,true"');
    const beyond = browse("find", "role", "checkbox", "check", "--name", "No middle name", "--nth", "2");
    expect(beyond.status).toBe(1);
    expect(beyond.err).toContain("--nth 2 asks for match 3, and only 2 checkbox elements match (--nth counts from 0)");
    expect(browse("find", "text", "Go", "--nth", "0").err).toContain("--nth works with find role");
  });

  test("a find role that matches nothing leads with the closest name and its ref", () => {
    const missed = browse("find", "role", "button", "click", "--name", "Archived", "--exact");
    expect(missed.status).toBe(1);
    const found = /closest: button "Archived · 1" (@e\d+)/u.exec(missed.err);
    expect(found).not.toBeNull();
    expect(missed.err.indexOf("closest:")).toBeLessThan(missed.err.indexOf("the buttons here are"));
    expect(browse("click", (found as RegExpExecArray)[1] as string).status).toBe(0);
    expect(browse("get", "text", "#out").out.trim()).toBe("archived");
    const json = JSON.parse(browse("--json", "find", "role", "button", "click", "--name", "Archived", "--exact").out);
    expect(json.data.closest.name).toBe("Archived · 1");
  });

  test("fill takes literal text after a leading -s, links refuses what it can't honour, and empty selectors are usage errors", () => {
    expect(browse("fill", "-s", "#name", "-s").status).toBe(0);
    expect(browse("get", "value", "#name").out.trim()).toBe("-s");
    expect(browse("fill", "--selector=#name", "--selector").status).toBe(0);
    expect(browse("get", "value", "#name").out.trim()).toBe("--selector");
    const scoped = browse("links", "-s", "nav");
    expect(scoped.status).toBe(1);
    expect(scoped.err).toContain("Unknown flag");
    const limited = browse("links", "--limit", "1", "nav-only");
    expect(limited.out).toContain("https://example.com/nav-only");
    expect(limited.out).not.toContain("https://example.com/a\n");
    expect(browse("fill", "-s", "--", "#name", "new").err).toContain("needs a selector");
    expect(browse("click", "#intro", "-s", "#go").err).toContain("give the selector once");
    expect(browse("screenshot", "-s", "#intro", path.join(root, "one.png"), path.join(root, "two.png")).err).toContain("takes one path");
    expect(browse("get", "attr", "-s", "#lnk", "data-kind").out.trim()).toBe("plain");
    expect(browse("get", "text", "-s", "#intro", "extra").err).toContain("give the selector once");
    const empty = browse("screenshot", "--selector=", path.join(root, "empty.png"));
    expect(empty.status).toBe(1);
    expect(empty.err).toContain("needs a selector");
  });

  test("an ambiguous closest name gives no ref, --nth misses fall back to the hint, and a bad --nth is a usage error", () => {
    const twins = browse("find", "role", "button", "click", "--name", "Twin", "--exact");
    expect(twins.err).toContain("closest: button \"Twin · 2\", 2 of them (find role button <action> --name 'Twin · 2' --exact --nth <n>, from 0)");
    expect(twins.err).not.toMatch(/closest: button "Twin · 2" @e/u);
    const nthMiss = browse("find", "role", "button", "click", "--name", "Archived", "--exact", "--nth", "0");
    expect(nthMiss.err).toContain('closest: button "Archived · 1" @e');
    const bogus = browse("find", "role", "button", "click", "--name", "Go", "--nth", "bogus");
    expect(bogus.status).toBe(1);
    expect(bogus.err).toContain("--nth takes a number counting from 0, not bogus");
  });

  test("the closest hint's retry picks from the same set it counted, and flows mask a flagged fill", () => {
    const cased = browse("find", "role", "button", "click", "--name", "MIXED", "--exact");
    expect(cased.err).toContain("closest: button \"MIXED 4\", 2 of them (find role button <action> --name 'MIXED 4' --exact --nth <n>, from 0)");
    expect(browse("find", "role", "button", "click", "--name", "MIXED 4", "--exact", "--nth", "1").status).toBe(0);
    expect(browse("fill", "-s", "#password", "hunter2-secret-value").status).toBe(0);
    const steps = browse("flow", "steps", "--all");
    expect(steps.out).not.toContain("hunter2-secret-value");
    const shot = browse("screenshot", "#intro", "-s", "#go");
    expect(shot.status).toBe(1);
    expect(shot.err).toContain("isn't a file path");
    expect(browse("click", "-s", "--").err).toContain("needs a selector");
  });
});

