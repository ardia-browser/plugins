import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(90_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
let PORT = 0;

const SHOP = `<!doctype html><meta charset="utf-8"><title>Shop</title>
<header><nav><a href="#a">Home</a><a href="#b">Cart</a></nav></header>
<main><h1>Products</h1>
<div style="opacity:0">Saved! Your order shipped</div>
<div style="height:0;overflow:hidden">Collapsed secret text</div>
<ul><li><div><div><span>Card Alpha</span><button>Delete</button></div></div></li><li><div><span>Card Beta</span><button>Delete</button></div></li></ul>
<button data-testid="close-x"><svg><use href="#icon-close"></use></svg></button>
${Array.from({ length: 60 }, (_, index) => `<p>Filler paragraph number ${index} with enough words to be worth trimming away</p>`).join("")}
<div id="modal" role="dialog" aria-modal="true" aria-label="Sign in" style="position:fixed;left:30%;top:30%;width:40%;height:40%;background:#fff;z-index:3"><h2>Welcome back</h2><label>Email <input></label><button>Continue</button></div>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2"></div>
<div role="dialog" style="position:fixed;left:0;top:0;width:50px;height:50px;z-index:1">Under</div>
</main>
<button id="close" style="position:fixed;right:0;bottom:0;z-index:4" onclick="document.getElementById('modal').remove()">Close modal</button>`;

function widgets(framePort: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Widgets</title><h1>Widgets</h1><x-card></x-card>
<script>customElements.define("x-card", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "closed" });
root.innerHTML = '<p>Inside closed</p><span style="opacity:0">Ghost text</span><div style="cursor:pointer" onclick="this.textContent=\\'Opened\\'">Open details</div><button>Buy</button>'; } });</script>
<iframe src="http://localhost:${framePort}/frame" width="400" height="200"></iframe>
<button id="swap" onclick="document.body.innerHTML='<h2>Totally new</h2><button>Fresh</button>'">Swap</button>`;
}
const FRAME = `<!doctype html><meta charset="utf-8"><title>Frame</title><p>Cross site frame</p><button onclick="this.textContent='Frame clicked'">Frame button</button>`;
const STACKED = `<!doctype html><meta charset="utf-8"><title>Stacked</title><p>Behind both</p>
<div role="dialog" aria-modal="true" aria-label="Front" style="position:fixed;left:350px;top:100px;width:150px;height:80px;background:#fff;z-index:5"><button>Front button</button></div>
<div role="dialog" aria-modal="true" aria-label="Back" style="position:fixed;left:0;top:0;width:600px;height:400px;background:#eee;z-index:4"><button>Back button</button></div>`;
const DIVHOST = `<!doctype html><meta charset="utf-8"><title>Div host</title><h1>Plain host</h1><div id="host"></div>
<script>document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = '<span style="opacity:0">Div ghost</span><p>Div shown</p><div style="cursor:pointer" onclick="1">Div clicker</div>';</script>`;
const TICKER = `<!doctype html><meta charset="utf-8"><title>Ticker</title><h1>Ticker</h1><p id="tick">0</p>
<script>let ticks = 0; setInterval(() => { document.getElementById("tick").textContent = String(++ticks); }, 5);</script>`;
const ALERT = `<!doctype html><meta charset="utf-8"><title>Alert</title><h1>Account</h1>${Array.from({ length: 40 }, (_, index) => `<button>Action ${index}</button>`).join("")}<button id="open" onclick="document.body.insertAdjacentHTML('beforeend', '<div role=alertdialog aria-label=Session style=&quot;position:fixed;left:10px;top:10px;width:200px;height:60px&quot;>Your session expired</div>'); document.querySelectorAll('button').forEach((el, index) => { if (index < 40) el.textContent = 'Renamed ' + index; })">Expire</button>`;
const MODAL_LATER = `<!doctype html><meta charset="utf-8"><title>Later</title><h1>Base page</h1><button id="open" onclick="document.body.insertAdjacentHTML('beforeend', '<div role=dialog aria-modal=true aria-label=Late style=&quot;position:fixed;inset:20%;background:#fff&quot;><button>Late button</button></div>')">Open it</button>`;

let root = "";
let chrome: ChildProcess | null = null;
let server: ChildProcess | null = null;
let pagePort = 0;

const SERVER = `
const http = require("node:http");
const pages = JSON.parse(process.argv[2]);
const start = (routes) => new Promise((resolve) => {
  const server = http.createServer((request, response) => {
    const body = routes()[request.url];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
    response.end(body === undefined ? "" : body);
  });
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
(async () => {
  const framePort = await start(() => ({ "/frame": pages.frame }));
  const pagePort = await start(() => Object.fromEntries(Object.entries(pages).map(([name, body]) => ["/" + name, body.replace("FRAME_PORT", String(framePort))])));
  process.stdout.write(pagePort + "\\n");
})();
`;

function serve(): Promise<number> {
  const file = path.join(root, "server.cjs");
  fs.writeFileSync(file, SERVER);
  const child = spawn(process.execPath, [file, JSON.stringify({ shop: SHOP, widgets: widgets("FRAME_PORT"), frame: FRAME, stacked: STACKED, divhost: DIVHOST, ticker: TICKER, later: MODAL_LATER, alert: ALERT })], { stdio: ["ignore", "pipe", "inherit"] });
  server = child;
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) resolve(Number(out.trim()));
    });
    child.on("exit", (code) => reject(new Error(`the page server exited with ${code}`)));
  });
}

function launchedEndpoint(profile: string): { port: number; path: string } | null {
  try {
    const [port, endpoint] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
    return Number(port) > 0 && endpoint ? { port: Number(port), path: endpoint } : null;
  } catch {
    return null;
  }
}

function ours(port: number, endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 500, agent: false }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.on("end", () => {
        try {
          resolve(response.statusCode === 200 && String((JSON.parse(body) as Record<string, unknown>)["webSocketDebuggerUrl"]).endsWith(endpoint));
        } catch {
          resolve(false);
        }
      });
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => request.destroy());
  });
}

function browse(...args: string[]): { status: number | null; out: string; err: string } {
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off" };
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "shaping", ...args], { env, cwd: root, encoding: "utf8", timeout: 60_000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

function json(...args: string[]): Record<string, unknown> {
  return JSON.parse(browse("--json", ...args).out) as Record<string, unknown>;
}

describe.skipIf(!CHROME)("snapshot shaping against headless Chrome", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-shaping-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    pagePort = await serve();
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", "--site-per-process", "--remote-debugging-port=0", `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    const profile = path.join(root, "profile");
    let launched = launchedEndpoint(profile);
    while (performance.now() < deadline && (launched === null || !(await ours(launched.port, launched.path)))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      launched = launchedEndpoint(profile);
    }
    expect(launched !== null && (await ours(launched.port, launched.path))).toBe(true);
    PORT = (launched as { port: number }).port;
  }, 60_000);

  afterAll(() => {
    if (root) browse("close");
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    server?.kill("SIGKILL");
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("an open modal scopes the snapshot to the topmost dialog, and --all shows the page without hidden text", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/shop`, "--no-changes").status).toBe(0);
    const scoped = browse("snapshot");
    expect(scoped.status).toBe(0);
    const lines = scoped.out.trimEnd().split("\n");
    expect(lines[0]).toBe('(dialog "Sign in" is open on top of the page, so this snapshot shows only it; snapshot --all shows the whole page)');
    expect(scoped.out).toContain('button "Continue"');
    expect(scoped.out).not.toContain("Products");
    expect(scoped.out).not.toContain("Under");
    const data = json("snapshot") as { data: { modal: { role: string; name: string }; refs: Record<string, { name: string }> } };
    expect(data.data.modal.name).toBe("Sign in");
    expect(Object.values(data.data.refs).some((ref) => ref.name === "Products")).toBe(false);
    const whole = browse("--full", "snapshot", "--all");
    expect(whole.out).toContain('heading "Products"');
    expect(whole.out).not.toContain("Saved! Your order shipped");
    expect(whole.out).not.toContain("Collapsed secret text");
    expect(whole.out).toContain('(near "Card Alpha")');
    expect(whole.out).toContain('(icon "icon-close")');
    expect(browse("snapshot", "--no-modal-scope").out).toContain('heading "Products"');
  });

  test("a snapshot over the cap keeps its controls, ends with what it left out, and gives no ref it didn't print", () => {
    const capped = browse("--max-output", "900", "snapshot", "--all");
    expect(capped.status).toBe(0);
    expect(capped.out.trimEnd().length <= 900).toBe(true);
    expect(capped.err).not.toContain("[output capped at ");
    const last = capped.out.trimEnd().split("\n").at(-1) as string;
    expect(last.startsWith("[fit to 900 chars, controls first: ")).toBe(true);
    expect(capped.out).toContain('button "Continue"');
    expect(capped.out).toContain('link "Home"');
    expect(capped.out).not.toContain("Filler paragraph number 59");
    const listed = json("--max-output", "900", "snapshot", "--all") as { data: { snapshot: string; fit?: unknown } };
    expect(listed.data.fit).toBe(undefined);
    expect(listed.data.snapshot).toContain("Filler paragraph number 59");
  });

  test("find prints each match with 3 lines around it and its container path", () => {
    const found = browse("snapshot", "find", "Delete", "--all");
    expect(found.status).toBe(0);
    expect(found.out.split("\n")[0]).toMatch(/^snapshot find "Delete": 2 matches in \d+ lines$/u);
    expect(found.out).toContain("in: main > list > listitem");
    expect(found.out).toMatch(/^> +- button "Delete" \[ref=e\d+\] \(near "Card Alpha"\)$/mu);
    const pattern = json("snapshot", "find", "/^heading/", "--all") as { data: { count: number; matches: { path: string }[] } };
    expect(pattern.data.count).toBe(2);
  });

  test("closing the modal lifts the scope, and --diff-new lists only what appeared", () => {
    browse("snapshot", "--all");
    expect(browse("click", "#close", "--no-changes").status).toBe(0);
    const after = browse("snapshot", "--diff-new");
    expect(after.out.split("\n")[0]).toMatch(/^snapshot --diff-new \(nothing new since your snapshot \d+ commands? ago; earlier refs stay valid\)$/u);
    expect(browse("snapshot").out).toContain('heading "Products"');
  });

  test("closed shadow roots, cross-process frames, paired capture and superseded refs", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/widgets`, "--no-changes").status).toBe(0);
    let snapshot = "";
    for (let tries = 0; tries < 20 && !snapshot.includes("Frame button"); tries += 1) {
      snapshot = browse("snapshot").out;
      if (!snapshot.includes("Frame button")) spawnSync("sleep", ["0.25"]);
    }
    expect(snapshot).toContain('StaticText "Inside closed"');
    expect(snapshot).not.toContain("Ghost text");
    expect(snapshot).toMatch(/generic "Open details" \[ref=e\d+\] clickable \[cursor:pointer, onclick\]/u);
    const frameRef = /button "Frame button" \[ref=(f\d+e\d+)\]/u.exec(snapshot)?.[1] as string;
    expect(frameRef).toMatch(/^f1e\d+$/u);
    expect(browse("click", `@${frameRef}`).status).toBe(0);
    expect(browse("snapshot", "find", "Frame clicked").out).toContain("1 match");
    const openRef = /generic "Open details" \[ref=(e\d+)\]/u.exec(snapshot)?.[1] as string;
    expect(browse("click", `@${openRef}`).status).toBe(0);
    const png = path.join(root, "pair.png");
    const paired = json("snapshot", "-i", "--with-screenshot", png) as { data: { epoch: number; screenshot: { width: number; height: number; stable: boolean; boxes: { ref: string; x: number; y: number; width: number; height: number }[] } } };
    expect(fs.readFileSync(png).subarray(1, 4).toString()).toBe("PNG");
    expect(paired.data.screenshot.stable).toBe(true);
    const frameBox = paired.data.screenshot.boxes.find((box) => box.ref === frameRef);
    expect(frameBox !== undefined && frameBox.x > 0 && frameBox.y > 0 && frameBox.x + frameBox.width <= paired.data.screenshot.width).toBe(true);
    const shot = browse("screenshot", path.join(root, "pair2.png"), "--with-snapshot");
    expect(shot.out.split("\n")[0]).toMatch(/^✓ Screenshot saved to .*pair2\.png \(\d+×\d+ px, \d+ ref boxes in image pixels\)$/u);
    const epoch = paired.data.epoch;
    const heading = /heading "Widgets" \[level=1, ref=(e\d+)\]/u.exec(snapshot)?.[1] as string;
    expect(browse("click", "#swap", "--no-changes").status).toBe(0);
    const swapped = json("snapshot") as { data: { epoch: number } };
    expect(swapped.data.epoch).toBe(epoch + 1);
    const gone = JSON.parse(browse("--json", "click", `@${heading}`).out) as { code: string; error: string };
    expect(gone.code).toBe("vocab_superseded");
    expect(gone.error).toContain("nothing in common with that snapshot");
    expect(browse("open", `http://127.0.0.1:${pagePort}/frame`, "--no-changes").status).toBe(0);
    const fresh = /button "Fresh" \[ref=(e\d+)\]/u.exec(browse("snapshot", "find", "Fresh").out);
    expect(fresh).toBe(null);
  });

  test("of two modals that both pass the five points, the one painted on top wins, whatever their order", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/stacked`, "--no-changes").status).toBe(0);
    const scoped = browse("snapshot");
    expect(scoped.out.split("\n")[0]).toBe('(dialog "Front" is open on top of the page, so this snapshot shows only it; snapshot --all shows the whole page)');
    expect(scoped.out).toContain('button "Front button"');
    expect(scoped.out).not.toContain("Back button");
  });

  test("a closed shadow root on a plain div is found too", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/divhost`, "--no-changes").status).toBe(0);
    const out = browse("snapshot").out;
    expect(out).toContain('StaticText "Div shown"');
    expect(out).not.toContain("Div ghost");
    expect(out).toMatch(/generic "Div clicker" \[ref=e\d+\] clickable \[cursor:pointer, onclick\]/u);
  });

  test("snapshot --diff reports a modal that opened, though the shaped snapshot would show only it", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/later`, "--no-changes").status).toBe(0);
    browse("snapshot", "--diff");
    expect(browse("click", "#open", "--no-changes").status).toBe(0);
    const changed = browse("snapshot", "--diff");
    expect(changed.out).toContain("Late button");
    expect(changed.out).not.toContain("changes: none");
    expect(browse("snapshot").out.split("\n")[0]).toBe('(dialog "Late" is open on top of the page, so this snapshot shows only it; snapshot --all shows the whole page)');
  });

  test("a paired capture retried on a busy page still lists what was new since the snapshot before it", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/ticker`, "--no-changes").status).toBe(0);
    browse("snapshot");
    expect(browse("eval", "document.body.insertAdjacentHTML('beforeend', '<button>Added later</button>')").status).toBe(0);
    const paired = JSON.parse(browse("--json", "snapshot", "--diff-new", "--with-screenshot", path.join(root, "busy.png")).out) as { data: { new: string[]; refs: Record<string, { name: string }>; screenshot: { stable: boolean } } };
    expect(paired.data.screenshot.stable).toBe(false);
    const added = Object.entries(paired.data.refs).find(([, ref]) => ref.name === "Added later")?.[0];
    expect(added !== undefined && paired.data.new.includes(added)).toBe(true);
  });

  test("find and --diff-new stay under the cap whole, headers included", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/shop`, "--no-changes").status).toBe(0);
    const found = browse("--max-output", "700", "snapshot", "find", "Filler");
    expect(found.out.trimEnd().length <= 700).toBe(true);
    expect(found.err).not.toContain("[output capped at ");
    expect(found.out.split("\n")[0]).toBe('(dialog "Sign in" is open on top of the page, so this snapshot shows only it; snapshot --all shows the whole page)');
    const all = browse("--max-output", "700", "snapshot", "find", "Filler", "--all");
    expect(all.out.trimEnd().length <= 700).toBe(true);
    expect(all.out).toMatch(/the first \d+ are shown, a longer query narrows it/u);
    expect(all.err).not.toContain("[output capped at ");
  });

  test("--diff reports a text-only alertdialog, fits the cap, and every ref it prints works", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/alert`, "--no-changes").status).toBe(0);
    browse("snapshot", "--diff");
    expect(browse("click", "#open", "--no-changes").status).toBe(0);
    const diffed = browse("--max-output", "500", "snapshot", "--diff");
    expect(diffed.status).toBe(0);
    expect(diffed.out.trimEnd().length <= 500).toBe(true);
    expect(diffed.err).not.toContain("[output capped at ");
    expect(diffed.out).toContain('+ alertdialog "Session" opened: "Your session expired"');
    const range = /(e\d+)…(e\d+)/u.exec(diffed.out);
    expect(range).not.toBe(null);
    expect(browse("get", "text", `@${(range as RegExpExecArray)[1]}`).out.trim()).toBe("Renamed 0");
    expect(browse("get", "text", `@${(range as RegExpExecArray)[2]}`).out.trim()).toBe("Renamed 39");
    browse("eval", "document.querySelectorAll('button').forEach((el, index) => { if (index < 40) el.textContent = 'Again ' + index; })");
    const tight = browse("--max-output", "120", "snapshot", "--diff");
    expect(tight.out.trimEnd().length <= 120).toBe(true);
    expect(tight.err).not.toContain("[output capped at ");
    expect(tight.out).toMatch(/\[\d+ more change lines? past the cap; --full lists them\]/u);
    const whole = browse("--full", "snapshot", "--diff");
    expect(whole.out).toContain("Again 0");
    expect(whole.out).not.toContain("changes: none");
  });

  test("-i --diff-new lists only additions, not the repeat -i diff", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/later`, "--no-changes").status).toBe(0);
    browse("snapshot", "-i");
    expect(browse("eval", "document.body.insertAdjacentHTML('beforeend', '<button>Brand new</button>')").status).toBe(0);
    const fresh = browse("snapshot", "-i", "--diff-new");
    expect(fresh.out.split("\n")[0]).toMatch(/^snapshot --diff-new \(1 new since your snapshot/u);
    expect(fresh.out).toContain('+ button "Brand new"');
    expect(fresh.out).not.toContain("since your snapshot 2 commands ago of");
  });

  test("a PNG that can't be written leaves the --diff-new baseline and gives no refs", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/later`, "--no-changes").status).toBe(0);
    browse("snapshot");
    expect(browse("eval", "document.body.insertAdjacentHTML('beforeend', '<button>After baseline</button>')").status).toBe(0);
    const blocker = path.join(root, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const failed = browse("snapshot", "--diff-new", "--with-screenshot", path.join(blocker, "shot.png"));
    expect(failed.status).toBe(1);
    const fresh = browse("snapshot", "--diff-new");
    expect(fresh.out).toContain('+ button "After baseline"');
  });

  test("a long paired path under a small cap shortens its line, and nothing is cut", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/shop`, "--no-changes").status).toBe(0);
    const deep = path.join(root, ...Array.from({ length: 12 }, () => "a-rather-long-folder-name"), "shot.png");
    const out = browse("--max-output", "300", "snapshot", "--all", "--with-screenshot", deep);
    expect(out.status).toBe(0);
    expect(out.out.trimEnd().length <= 300).toBe(true);
    expect(out.err).not.toContain("[output capped at ");
    expect(out.out.split("\n")[0]).toMatch(/^✓ Screenshot saved \(\d+×\d+ px, \d+ ref box(es)? in image pixels/u);
    expect(fs.existsSync(deep)).toBe(true);
  });

  test("tiny caps: --diff-new and the paired line fit whole or are left out", () => {
    expect(browse("open", `http://127.0.0.1:${pagePort}/later`, "--no-changes").status).toBe(0);
    browse("snapshot");
    expect(browse("eval", "document.body.insertAdjacentHTML('beforeend', '<button>Tiny cap</button>')").status).toBe(0);
    const tiny = browse("--max-output", "20", "snapshot", "--diff-new");
    expect(tiny.status).toBe(0);
    expect(tiny.out.trimEnd().length <= 20).toBe(true);
    expect(tiny.err).not.toContain("[output capped at ");
    expect(browse("snapshot", "--diff-new").out).toContain('+ button "Tiny cap"');
    const none = browse("--max-output", "20", "snapshot", "find", "nothing like this anywhere at all");
    expect(none.status).toBe(0);
    expect(none.out.trim()).toBe("");
    expect(none.err).not.toContain("[output capped at ");
    const paired = browse("--max-output", "100", "snapshot", "-i", "--with-screenshot", "p.png");
    expect(paired.out.trimEnd().length <= 100).toBe(true);
    expect(paired.err).not.toContain("[output capped at ");
    expect(paired.out.split("\n")[0]).toMatch(/^✓ Screenshot saved to p\.png \(\d+×\d+ px, \d+ ref box(es)? in image pixels\)$/u);
    for (const cap of ["50", "60", "70"]) {
      const squeezed = browse("--max-output", cap, "snapshot", "--with-screenshot", "q.png");
      expect(squeezed.status).toBe(0);
      expect(squeezed.out.trimEnd().length <= Number(cap)).toBe(true);
      expect(squeezed.err).not.toContain("[output capped at ");
    }
  });
});
