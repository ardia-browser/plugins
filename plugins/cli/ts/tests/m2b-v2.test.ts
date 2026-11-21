import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { parseText, type Value } from "../src/json.ts";
import { manifestProblems } from "../src/plugin-rules.ts";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-m2b-v2-"));
const check = (doc: unknown): string[] => manifestProblems({ data_dir: DATA }, parseText(JSON.stringify(doc)) as Map<string, Value>);

const V2 = (): any => ({
  manifest: 2,
  name: "reader",
  title: "Reader",
  icon: "book",
  main: "dist/index.js",
  permissions: { tabs: "read", activePage: true, storage: true, secrets: true, network: ["api.example.com", "*.cdn.example.com"] },
  contributes: {
    commands: [
      { name: "summarize", title: "Summarize Page", when: "urlScheme == 'https' && !isPinned" },
      { name: "browse", title: "Browse Notes", view: "notes" },
      { name: "panel", title: "Open Reader Panel", panel: "side" },
    ],
    menus: { tab: [{ command: "summarize" }], group: [{ command: "summarize", title: "Summarize Group", when: "urlHost ~= '*.example.com'" }] },
    toolbar: [{ id: "go", title: "Reader", icon: "book", view: "quick" }],
    sidebarViews: [{ id: "notes", title: "Notes", icon: "note.text" }],
    panels: [
      { id: "default", title: "Reader", mode: "tab", file: "page/index.html" },
      { id: "side", title: "Reader Side", mode: "sidecar", view: "side" },
    ],
    omnibox: [{ id: "notes", title: "Notes", keyword: "n" }],
    themes: [{ id: "dusk", title: "Dusk", file: "themes/dusk.json" }],
    settings: { rows: [{ key: "limit", title: "Limit", type: "number", default: 5, min: 1, max: 10 }, { key: "token", title: "API token", type: "secret" }] },
    hooks: ["tab.opening"],
  },
});

test("the app's own valid v2 manifest checks ok", () => {
  assert.deepEqual(check(V2()), []);
});

test("every v2 manifest the app refuses is refused, in the app's words once the schema lets it through", () => {
  const cases: [(d: any) => void, string][] = [
    [(d) => void delete d.main, ".view needs a main"],
    [(d) => void delete d.main, "contributes.sidebarViews needs a main"],
    [(d) => void delete d.main, "contributes.omnibox needs a main"],
    [(d) => void delete d.main, "contributes.toolbar[0].view needs a main"],
    [(d) => void delete d.main, "hooks needs a main or a sidecar"],
    [(d) => void (d.contributes.menus.tab = [{ command: "nope" }]), "contributes.menus.tab[0].command: nope isn't one of this plugin's commands"],
    [(d) => void (d.contributes.toolbar = [{ id: "a", title: "A", icon: "a", command: "nope" }]), "contributes.toolbar[0].command: nope isn't one of this plugin's commands"],
    [(d) => void (d.contributes.toolbar = [{ id: "a", title: "A", icon: "a" }]), "contributes.toolbar[0] needs either command or view"],
    [(d) => void (d.contributes.commands[0].when = "urlHost = 'x'"), "contributes.commands[0].when"],
    [(d) => void (d.contributes.commands[0].when = "secretKey == 1"), "isn't one of urlHost"],
    [(d) => void (d.contributes.commands[0].when = "hasSelection"), "names hasSelection, which isn't one of"],
    [(d) => void (d.permissions.network = ["http://evil.com"]), "permissions.network[0] must be a bare host"],
    [(d) => void (d.permissions.network = ["*.com"]), "permissions.network[0] must put * in front of a domain with at least two parts"],
    [(d) => void (d.sidecar = { run: ["bin/x"] }), "a sidecar can only have \"*\" or false"],
    [(d) => void (d.permissions.workspace = true), "workspace needs tabs: write and fullUrls"],
    [(d) => void (d.permissions.secrets = false), "a secret row needs the secrets permission"],
    [(d) => void (d.contributes.settings.rows[1].default = "x"), "can't go with a secret"],
    [(d) => void (d.contributes.settings.rows[0].default = 50), "default must be a number between its min and max"],
    [(d) => void (d.activationEvents = ["onSomething:x"]), "activationEvents[0] must be *"],
    [(d) => void (d.activationEvents = ["onUrl:*"]), "activationEvents[0] has a bad onUrl argument"],
    [(d) => void (d.contributes.panels[1].file = "a.html"), "takes a file or a view, not both"],
    [(d) => void (d.contributes.omnibox = [{ id: "x", title: "X" }]), "needs a keyword or global: true"],
    [(d) => void (d.contributes.themes[0].file = "themes/dusk.css"), "contributes.themes[0].file must be a .json file"],
    [(d) => void (d.contributes.commands[2].panel = "nope"), "contributes.commands[2].panel: nope isn't one of this plugin's panels"],
    [(d) => void (d.main = "../escape.js"), "main must be a JavaScript file inside the plugin's folder"],
    [(d) => void (d.sidecar = { run: ["/usr/bin/python3"] }), "a plugin can declare main or sidecar, not both"],
    [(d) => void (d.contributes.menus.page = [{ command: "summarize" }]), "contributes.menus.page isn't a key of contributes.menus"],
    [(d) => void (d.contributes.menus.link = [{ command: "summarize" }]), "contributes.menus.link isn't a key"],
    [(d) => void (d.contributes.menus.selection = [{ command: "summarize" }]), "contributes.menus.selection isn't a key"],
    [(d) => void (d.contributes.panels[1].mode = "popover"), "contributes.panels[1].mode must be sidecar, tab, split"],
    [(d) => void (d.contributes.commands[0].shortcut = "cmd+shift+s"), "contributes.commands[0].shortcut isn't a key"],
    [(d) => void (d.contributes.omnibox = [{ id: "x", title: "X", keyword: "x", global: true }]), "contributes.omnibox[0] takes a keyword or global: true, not both"],
    [(d) => void (d.main = "index.py"), "main must be a .js"],
    [(d) => void (d.memoryMB = 9), "memoryMB must be a whole number from 64 to 4096"],
    [(d) => void (d.permissions = ["tabs"]), "permissions must be an object"],
    [(d) => void (d.commands = []), "commands isn't a key of a plugin"],
  ];
  for (const [patch, words] of cases) {
    const doc = V2();
    patch(doc);
    const found = check(doc);
    assert.ok(found.length > 0, `ok for: ${words}`);
  }
  const noMain = V2();
  delete noMain.main;
  noMain.activationEvents = ["*"];
  assert.ok(check(noMain).includes("activationEvents only go with a main"));
});

test("app rules the schema can't express come out in the app's words", () => {
  const cases: [(d: any) => void, string][] = [
    [(d) => void (d.contributes.menus.tab = [{ command: "nope" }]), "contributes.menus.tab[0].command: nope isn't one of this plugin's commands"],
    [(d) => void (d.contributes.commands[2].panel = "nope"), "contributes.commands[2].panel: nope isn't one of this plugin's panels"],
    [(d) => void (d.permissions.secrets = false), "a secret row needs the secrets permission"],
    [(d) => void (d.sidecar = { run: ["/usr/bin/python3"] }), "a plugin can declare main or sidecar, not both"],
    [(d) => void (d.contributes.commands[0].when = "secretKey == 1"), "isn't one of urlHost"],
    [(d) => void (d.permissions.tabs = undefined), "contributes.hooks[0]: tab.opening needs the tabs permission"],
  ];
  for (const [patch, words] of cases) {
    const doc = V2();
    patch(doc);
    const found = check(JSON.parse(JSON.stringify(doc)));
    assert.ok(found.some((p) => p.includes(words)), `${words}\n${found.join("\n")}`);
  }
});

test("a v2 command with nothing to do needs a main", () => {
  const doc = { manifest: 2, name: "bare", contributes: { commands: [{ name: "x", title: "X" }] } };
  assert.ok(check(doc).some((p) => p.includes("needs either tool")));
  assert.ok(check({ ...doc, contributes: { commands: [{ name: "x", title: "X", handler: true }] } }).some((p) => p.includes("handler needs a main")));
  assert.deepEqual(check({ ...doc, main: "index.js" }), []);
});

test("manifest 3 needs a newer Ardia", () => {
  assert.deepEqual(check({ manifest: 3, name: "x" }), ["manifest 3 needs a newer Ardia (this one reads up to 2)"]);
});
