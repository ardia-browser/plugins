import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(90_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 21;

const PAGE = `<!doctype html><title>Shop</title><main>
<h1>Products</h1>
<div class="card"><h2>Red Mug</h2><span class="price">$12</span><a href="/p/1">View</a></div>
<div class="card"><h2>Blue Cup</h2><span class="price">$9</span><a href="/p/2">View</a></div>
<table id="t"><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Mug</td><td>2</td></tr><tr><td>Cup</td><td>5</td></tr></tbody></table>
<form>
<label for="name">Full name</label><input id="name" required>
<label>Email <input type="email" name="email" value="a@b.c"></label>
<label><input type="checkbox" name="terms"> Accept terms</label>
<label for="pw">Password</label><input id="pw" type="password" value="hunter22">
<button type="button" id="redraw">Redraw</button>
<button type="button" id="save">Save</button>
<button type="button" class="dup">Delete</button>
<button type="button" class="dup">Delete</button>
<span id="out"></span>
</form></main>
<script>
function wire(button) { button.addEventListener("click", () => { document.getElementById("out").textContent = "saved"; }); }
document.getElementById("redraw").addEventListener("click", () => {
  const old = document.getElementById("save");
  const fresh = old.cloneNode(true);
  old.replaceWith(fresh);
  wire(fresh);
  document.querySelectorAll(".dup").forEach((item) => item.replaceWith(item.cloneNode(true)));
});
wire(document.getElementById("save"));
</script>`;

const EDGE = `<!doctype html><title>Edge</title><main>
<div role="dialog" aria-label="Confirm" id="dlg"><button type="button" id="inner">Remove</button></div>
<button type="button" id="swap">Swap</button>
<span id="hit">none</span>
<form id="sec">
<label for="otp">Code</label><input id="otp" autocomplete="ONE-TIME-CODE" value="831245">
<label for="pw2">Secret</label><input id="pw2" type="password" value="hunter22">
<label for="flip">Flip</label><input id="flip" type="password" value="sesame77">
<button type="button" id="flipper">Flip it</button>
<div role="combobox" aria-label="Who"><input aria-label="Who" value="Ana"></div>
<fieldset disabled><label for="locked">Locked</label><input id="locked" value="x"></fieldset>
</form></main>
<script>
document.getElementById("pw2").setCustomValidity("hunter22 is too weak");
document.getElementById("inner").addEventListener("click", () => { document.getElementById("hit").textContent = "dialog clicked"; });
document.getElementById("swap").addEventListener("click", () => {
  document.getElementById("dlg").remove();
  const outside = document.createElement("button");
  outside.type = "button";
  outside.textContent = "Remove";
  outside.addEventListener("click", () => { document.getElementById("hit").textContent = "background clicked"; });
  document.querySelector("main").prepend(outside);
});
document.getElementById("flipper").addEventListener("click", () => { document.getElementById("flip").type = "text"; });
</script>`;

const MANY = `<!doctype html><title>Many</title><main><div id="many"></div><table id="wide"><tbody><tr id="row"></tr></tbody></table>
<table id="dup"><thead><tr><th>Price</th><th>Price</th></tr></thead><tbody><tr><td>10</td><td>20</td></tr><tr style="display:none"><td>hidden</td><td>row</td></tr></tbody></table>
<a id="long" class="link" href="/${"x".repeat(2000)}">long</a></main>
<script>
const many = document.getElementById("many");
for (let index = 0; index < 20000; index += 1) {
  const item = document.createElement("span");
  item.className = "m";
  item.textContent = "m" + index;
  many.appendChild(item);
}
const row = document.getElementById("row");
for (let index = 0; index < 60; index += 1) row.insertCell().textContent = "c" + index;
</script>`;

const FIELDS = `<!doctype html><title>Fields</title><main><form id="f"></form></main>
<script>
const form = document.getElementById("f");
for (let index = 0; index < 3000; index += 1) {
  const input = document.createElement("input");
  input.name = "n" + index;
  form.appendChild(input);
}
</script>`;

let root = "";
let chrome: ChildProcess | null = null;
let server: http.Server | null = null;
let site = "";

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

function run(args: string[], stdin: string | null = null): Promise<{ status: number | null; out: string; err: string }> {
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off", AGENT_BROWSER_CONTENT_BOUNDARIES: "0" };
  return new Promise((resolve) => {
    const child = spawn(PROGRAM, args, { env, cwd: root, stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    if (stdin !== null) child.stdin?.end(stdin);
    const timer = setTimeout(() => child.kill("SIGKILL"), 80_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out, err });
    });
  });
}

function browse(args: string[], stdin: string | null = null): Promise<{ status: number | null; out: string; err: string }> {
  return run(["browse", "--port", String(PORT), "--session", "roundtrip", ...args], stdin);
}

function refOf(listing: string, label: string): string {
  const line = listing.split("\n").find((row) => row.includes(`"${label}"`) && row.includes("ref="));
  const found = line ? /ref=(e[0-9]+)/u.exec(line) : null;
  if (!found) throw new Error(`no ref for ${label} in:\n${listing}`);
  return found[1] as string;
}

describe.skipIf(!CHROME)("round-trip commands against headless Chrome (plugins#148)", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-roundtrip-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    server = http.createServer((request, response) => {
      const pages: Record<string, string> = { "/edge.html": EDGE, "/many.html": MANY, "/fields.html": FIELDS };
      const extra = pages[request.url ?? ""];
      if (extra !== undefined) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(extra);
        return;
      }
      if (request.url === "/page.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
        return;
      }
      const product = /^\/p\/([0-9]+)$/u.exec(request.url ?? "");
      if (product) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>P${product[1]}</title><nav>menu</nav><h1>Product ${product[1]}</h1><p>Details ${product[1]}.</p>`);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" }).end("missing");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, `${site}/page.html`], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await answers())) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await answers()).toBe(true);
  }, 90_000);

  afterAll(async () => {
    if (root) await browse(["close"]);
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("here picks the shown tab and lists what to act on in one call", async () => {
    let here = await browse(["here"]);
    for (let tries = 0; tries < 20 && !here.out.includes('button "Save"'); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      here = await browse(["here"]);
    }
    expect(here.status, here.err).toBe(0);
    expect(here.out.split("\n")[0]).toBe("✓ Shop");
    expect(here.out).toContain('button "Save" [ref=');
  });

  test("a batch follows a ref the page redrew, and lists the matches when several share it", async () => {
    const listing = (await browse(["snapshot", "-i", "--full"])).out;
    const healed = await browse(["batch", `click @${refOf(listing, "Redraw")}`, `click @${refOf(listing, "Save")}`, "get text #out"]);
    expect(healed.status, healed.out + healed.err).toBe(0);
    expect(healed.out).toMatch(/↻ @e[0-9]+→@e[0-9]+/u);
    expect(healed.out).toContain("saved");
    const again = (await browse(["snapshot", "-i", "--full"])).out;
    const ambiguous = await browse(["batch", `click @${refOf(again, "Redraw")}`, `click @${refOf(again, "Delete")}`]);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.out + ambiguous.err).toMatch(/→ 2 match it now, so nothing was picked: button "Delete" \[ref=e[0-9]+\], button "Delete" \[ref=e[0-9]+\]/u);
  });

  test("form lists fields with state and refs, masks the password, and fill takes a label", async () => {
    const form = await browse(["form"]);
    expect(form.status, form.err).toBe(0);
    expect(form.out).toContain('- textbox "Full name" [required, invalid: ');
    expect(form.out).toContain('- checkbox "Accept terms" [checked=false, ref=');
    expect(form.out).toContain(": ••••");
    expect(form.out).not.toContain("hunter22");
    const filled = await browse(["batch", 'fill "Full name" "Ana Ruiz"', 'check "Accept terms"', 'find label "Accept terms" is checked']);
    expect(filled.status, filled.out + filled.err).toBe(0);
    expect(filled.out.trim().split("\n").at(-1)).toBe("true");
  });

  test("query reads cards and tables as rows", async () => {
    const cards = await browse(["query", ".card", "--fields", "name=h2,price=.price,url=a@href"]);
    expect(cards.status, cards.err).toBe(0);
    expect(cards.out).toContain(`{"name": "Red Mug", "price": "$12", "url": "${site}/p/1"}`);
    const table = await browse(["query", "#t"]);
    expect(table.out).toContain('{"Item": "Cup", "Qty": "5"}');
  });

  test("read-urls fetches pages from the tab in parallel and reports failures one per line", async () => {
    const read = await browse(["read-urls", "/p/1", "/p/2", "/missing"]);
    expect(read.status, read.err).toBe(0);
    expect(read.out.split("\n")[0]).toMatch(/^read-urls: 2 of 3 read in /u);
    expect(read.out).toContain("# Product 2");
    expect(read.out).toContain("✗ " + site + "/missing: HTTP 404");
  });

  test("a ref removed with its dialog never follows a same-named button outside it", async () => {
    expect((await browse(["open", `${site}/edge.html`])).status).toBe(0);
    const listing = (await browse(["snapshot", "-i", "--full", "--all"])).out;
    const moved = await browse(["batch", `click @${refOf(listing, "Swap")}`, `click @${refOf(listing, "Remove")}`, "get text #hit"]);
    expect(moved.out + moved.err).not.toContain("↻");
    expect(moved.out + moved.err).not.toContain("background clicked");
    expect(moved.out + moved.err).toContain("(stale_ref)");
    expect(moved.out + moved.err).toContain("→ not followed for you:");
    const hit = await browse(["get", "text", "#hit"]);
    expect(hit.out.trim()).toBe("none");
  });

  test("form never prints a secret: odd-case autocomplete, a validation message holding it, a field flipped to text", async () => {
    expect((await browse(["open", `${site}/edge.html`])).status).toBe(0);
    const first = await browse(["form"]);
    const firstJson = await browse(["--json", "form"]);
    expect(first.status, first.err).toBe(0);
    expect(first.out).toContain('- textbox "Secret" [type=password, invalid: invalid, ref=');
    expect((await browse(["click", "#flipper"])).status).toBe(0);
    const after = await browse(["form"]);
    const afterJson = await browse(["--json", "form"]);
    for (const shown of [first, firstJson, after, afterJson]) {
      for (const secret of ["831245", "hunter22", "sesame77"]) expect(shown.out + shown.err).not.toContain(secret);
    }
    expect(after.out).toMatch(/- textbox "Flip" \[ref=e[0-9]+\]: ••••/u);
    expect(after.out).toMatch(/- textbox "Who" \[ref=e[0-9]+\]: Ana/u);
    expect(after.out).toMatch(/- textbox "Locked" \[disabled, ref=e[0-9]+\]: x/u);
  });

  test("query stops at --limit, caps columns and values; form stops at 200 fields", async () => {
    expect((await browse(["open", `${site}/many.html`])).status).toBe(0);
    const started = performance.now();
    const one = await browse(["query", ".m", "--limit", "1"]);
    expect(one.status, one.err).toBe(0);
    expect(one.out.split("\n")[0]).toBe("1 rows for .m, and more match (--limit 2 for more):");
    expect(performance.now() - started).toBeLessThan(15_000);
    const wide = await browse(["--json", "query", "#wide"]);
    const row = JSON.parse(wide.out).data.rows[0] as Record<string, string>;
    expect(Object.keys(row).length).toBe(30);
    const dup = await browse(["query", "#dup"]);
    expect(dup.out).toContain('{"Price": "10", "Price 2": "20"}');
    expect(dup.out).not.toContain("hidden");
    const link = await browse(["--json", "query", "#long", "--fields", "url=@href"]);
    expect((JSON.parse(link.out).data.rows[0].url as string).length).toBeLessThanOrEqual(300);
    expect((await browse(["open", `${site}/fields.html`])).status).toBe(0);
    const fields = await browse(["--json", "form"]);
    expect(JSON.parse(fields.out).data.count).toBe(200);
    expect(JSON.parse(fields.out).data.more).toBe(true);
    expect((await browse(["form"])).out.split("\n")[0]).toBe("form: 200 fields; more past the first 200: narrow with -s <selector>");
  });

  test("--help as an option's value or a positional runs the command instead of printing help", async () => {
    expect((await browse(["open", `${site}/page.html`])).status).toBe(0);
    const valued = await browse(["batch", "find role button --name --help click"]);
    expect(valued.out + valued.err).not.toContain("ardia browse find <role");
    expect(valued.out + valued.err).toContain("(not_found)");
  });

  test("--help exits 0 on a batch line, and --port is accepted after other commands", async () => {
    const help = await browse(["batch", "network requests --help"]);
    expect(help.status).toBe(0);
    expect(help.out).toContain("ardia browse network requests");
    const tabs = await run(["tabs", "--port", String(PORT)]);
    expect(tabs.err).not.toContain("doesn't take --port");
  });
});
