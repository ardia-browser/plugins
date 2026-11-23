import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 9;
const BOARD = `<!doctype html><meta charset="utf-8"><title>Task board</title><button id="b0">Item 0</button><button id="b1">Item 1</button><button id="b2">Item 2</button><button id="b3">Item 3</button><button id="b4">Item 4</button><button id="b5">Item 5</button><button id="b6">Item 6</button><button id="b7">Item 7</button><button id="b8">Item 8</button><button id="b9">Item 9</button><button id="b10">Item 10</button><button id="b11">Item 11</button><button id="add" onclick="const b=document.createElement('button');b.textContent='Fresh task';document.body.append(b);document.getElementById('b3').textContent='Item 3 done'">Add</button>`;
const CARDS = `<!doctype html><meta charset="utf-8"><title>Cards</title><div><span id="ha">Card Alpha</span><button>Delete</button></div>${["Beta", "Delta", "Echo", "Foxtrot", "Golf"].map((name) => `<div><span>Card ${name}</span><button>Delete</button></div>`).join("")}`;
const MENU = `<!doctype html><meta charset="utf-8"><title>Menu</title><menu><li><button>Cut</button></li><li><button>Paste</button></li></menu>`;
const OTHER = `<!doctype html><meta charset="utf-8"><title>Other page</title><button>Elsewhere</button>`;
const url = (page: string) => `data:text/html,${encodeURIComponent(page)}`;

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
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "diffs", ...args], { env, cwd: root, encoding: "utf8", timeout: 45_000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

describe.skipIf(!CHROME)("repeated snapshot -i against headless Chrome", () => {
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
    expect(browse("open", url(BOARD)).status).toBe(0);
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

  test("a repeated snapshot -i prints only what changed, says so first, and keeps refs valid", () => {
    const first = browse("snapshot", "-i");
    expect(first.out).toContain('button "Item 3"');
    const ref = /button "Item 0" \[ref=(e\d+)\]/u.exec(first.out)?.[1] as string;
    expect(browse("click", "#add").status).toBe(0);
    const second = browse("snapshot", "-i");
    const lines = second.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^snapshot -i \(changes since your snapshot 2 commands ago of "Task board"; \d+ refs unchanged and still valid; `snapshot -i --full` lists everything\)$/u);
    expect(second.out).toContain('+ button "Fresh task"');
    expect(second.out).toContain('~ button "Item 3 done"');
    expect(second.out).not.toContain('button "Item 7"');
    expect(second.out.length).toBeLessThan(first.out.length);
    expect(browse("click", `@${ref}`).status).toBe(0);
    const full = browse("snapshot", "-i", "--full");
    expect(full.out).toContain('button "Item 7"');
    const json = JSON.parse(browse("--json", "snapshot", "-i").out);
    expect(json.data.snapshot).toContain('button "Item 7"');
    expect(json.data.diff).toBeUndefined();
    const same = browse("snapshot", "-i");
    expect(same.out.split("\n")[0]).toContain("no changes since your snapshot");
  });

  test("a navigation gets the full list again", () => {
    expect(browse("open", url(OTHER)).status).toBe(0);
    const after = browse("snapshot", "-i");
    expect(after.out).not.toContain("since your snapshot");
    expect(after.out).toContain('button "Elsewhere"');
  });

  test("a capped snapshot doesn't become the baseline, --out saves the whole list, and a batch's earlier --full doesn't stop a diff", () => {
    expect(browse("open", url(BOARD)).status).toBe(0);
    expect(browse("snapshot", "-i").status).toBe(0);
    const capped = browse("snapshot", "-i", "--max-output", "60");
    expect(capped.err).toContain("[output capped at");
    const after = browse("snapshot", "-i");
    expect(after.out).not.toContain("since your snapshot");
    const saved = path.join(root, "snap.txt");
    expect(browse("snapshot", "-i", "--out", saved).status).toBe(0);
    expect(fs.readFileSync(saved, "utf8")).toContain('button "Item 7"');
    const batched = browse("batch", JSON.stringify(["get", "title", "--full"]), JSON.stringify(["snapshot", "-i"]));
    expect(batched.out).toContain("since your snapshot");
  });

  test("controls that only moved get the full list again", () => {
    expect(browse("snapshot", "-i").status).toBe(0);
    expect(browse("eval", "document.body.prepend(document.getElementById('b11'))").status).toBe(0);
    const moved = browse("snapshot", "-i");
    expect(moved.out).not.toContain("since your snapshot");
    expect(moved.out.indexOf('"Item 11"')).toBeLessThan(moved.out.indexOf('"Item 0"'));
  });

  test("a batch cut by its cap leaves the earlier baseline, so the next snapshot still diffs against it", () => {
    expect(browse("open", url(BOARD)).status).toBe(0);
    expect(browse("snapshot", "-i").status).toBe(0);
    expect(browse("click", "#add").status).toBe(0);
    const cut = browse("--max-output", "80", "batch", JSON.stringify(["snapshot", "-i"]));
    expect(cut.err).toContain("[output capped at");
    const after = browse("snapshot", "-i");
    expect(after.out.split("\n")[0]).toContain("since your snapshot");
    expect(after.out).toContain('+ button "Fresh task"');
  });

  test("a changed nearby label counts as a change", () => {
    expect(browse("open", url(CARDS)).status).toBe(0);
    expect(browse("snapshot", "-i").out).toContain('(near "Card Alpha")');
    expect(browse("eval", "document.getElementById('ha').textContent = 'Card Gamma'").status).toBe(0);
    const after = browse("snapshot", "-i");
    expect(after.out.split("\n")[0]).toContain("changes since your snapshot");
    expect(after.out).not.toContain("no changes since");
    expect(after.out).toContain('~ button "Delete"');
    expect(after.out).toContain('(near "Card Gamma")');
  });

  test("a read cut to fit keeps its whole note inside a batch, and a tiny cap doesn't cut the note", () => {
    const long = (n: number) => `<!doctype html><title>Long ${n}</title><main>${Array.from({ length: 80 }, (_, k) => `<p>Paragraph ${k} of ${n} ${"words ".repeat(12)}</p>`).join("")}</main>`;
    const urls = Array.from({ length: 10 }, (_, n) => url(long(n)));
    const batched = browse("--max-output", "12000", "batch", JSON.stringify(["read", ...urls]));
    expect(batched.status).toBe(0);
    expect(batched.err).toContain("[pages cut to fit 12,000 characters");
    const tiny = browse("--max-output", "20", "read", ...urls);
    expect(tiny.err).toMatch(/^\[\+10 pages not shown\. Narrow it: [^\n]*\(full output: [^)]*\)\]\n$/u);
  });

  test("a <menu> is a list -s can narrow to", () => {
    expect(browse("open", url(MENU)).status).toBe(0);
    const narrowed = browse("snapshot", "-i", "-s", "[role=list]");
    expect(narrowed.status).toBe(0);
    expect(narrowed.out).toContain('button "Paste"');
  });

  test("a snapshot only saved to a file leaves the earlier one as the baseline", () => {
    expect(browse("open", url(BOARD)).status).toBe(0);
    expect(browse("snapshot", "-i").out).toContain('button "Item 3"');
    expect(browse("click", "#add").status).toBe(0);
    const saved = browse("snapshot", "-i", "--out", path.join(root, "only-in-file.txt"));
    expect(saved.status).toBe(0);
    const after = browse("snapshot", "-i");
    expect(after.out).toContain('+ button "Fresh task"');
  });

  test("a batch line whose --out can't be written fails, and --bail stops the lines after it", () => {
    expect(browse("open", url(BOARD)).status).toBe(0);
    const failed = browse("batch", "--bail", JSON.stringify(["snapshot", "-i", "--out", root]), JSON.stringify(["click", "#add"]));
    expect(failed.status).toBe(1);
    expect(browse("get", "text", "#b3").out.trim()).toBe("Item 3");
  });
});
