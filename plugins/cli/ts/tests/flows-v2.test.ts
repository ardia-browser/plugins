import "./libc-loaded.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pyLoads } from "../src/browse/cdp/params.ts";
import { BrowseError, OutcomeUnknown } from "../src/browse/daemon-errors.ts";
import { type Action, actionFromReplay, actionProblem, candidateArgv, candidatesFromSelector, fingerprintArgv } from "../src/browse/flows/actions.ts";
import { addEpisodes, applyPatch, loadEpisodes, proposals, runValues } from "../src/browse/flows/episodes.ts";
import { driftReport, fixtureFiles, fixturePage, lostFields, shapeDrift, writeFixture } from "../src/browse/flows/fixture.ts";
import { buildFlow, load, runLocal, save, validate } from "../src/browse/flows/flows.ts";
import {
  candidateProblem,
  fingerprintOf,
  fragileClass,
  fragileId,
  fragileSelector,
  hardcodedValue,
  matchFingerprint,
  rankCandidates,
  selectorOf,
} from "../src/browse/flows/locators.ts";
import { type Driver, replay, replayStep } from "../src/browse/flows/replay.ts";

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-flows-v2-")));
  temps.push(dir);
  return dir;
}

class FakeDriver implements Driver {
  readonly ran: string[][] = [];
  constructor(
    private readonly answer: (argv: string[]) => Error | null,
    private page = "https://shop.example.com/",
  ) {}
  async run(argv: string[]): Promise<void> {
    this.ran.push(argv);
    const error = this.answer(argv);
    if (error) throw error;
  }
  async snapshot(): Promise<string> {
    return '- textbox "Search" [ref=e1]\n- button "Find" [ref=e2]\nsecret-value-123';
  }
  url(): string {
    return this.page;
  }
  matches = 1;
  async count(): Promise<number> {
    return this.matches;
  }
}

const missing = () => new BrowseError("Nothing matches", null, "not_found");

function searchAction(): Action {
  return {
    type: "click",
    intent: 'click the "Find" button',
    candidates: [
      { by: "aria-label", value: "Find" },
      { by: "css", value: "form > button.primary" },
    ],
    fingerprint: { role: "button", name: "Find" },
  };
}

describe("locators", () => {
  test("ranked candidates go aria-label, placeholder, name, test id, text, CSS, XPath and skip fragile ones", () => {
    const ranked = rankCandidates({
      tag: "input",
      role: "searchbox",
      name: "Search products",
      ariaLabel: "Search products",
      placeholder: "Search…",
      fieldName: "q",
      testId: "search-box",
      text: "",
      id: "ember1234",
      classes: ["css-1x2y3z"],
      css: "form > input.css-1x2y3z",
      xpath: "/html[1]/body[1]/form[1]/input[1]",
    });
    expect(ranked.map((candidate) => candidate.by)).toEqual(["aria-label", "placeholder", "name", "testid", "xpath"]);
    expect(selectorOf(ranked[0]!)).toBe('[aria-label="Search products"]');
    expect(selectorOf(ranked[2]!)).toBe('input[name="q"]');
    expect(selectorOf(ranked[3]!)).toBe('[data-testid="search-box"]');
    expect(selectorOf(ranked[4]!)).toBe("xpath=/html[1]/body[1]/form[1]/input[1]");
  });

  test("generated ids, UUIDs and hashed classes are fragile; plain words are not", () => {
    for (const id of ["ember1234", ":r1a:", "radix-:r4:-trigger7", "a3f9c2e1b7d4", "550e8400-e29b-41d4-a716-446655440000", "item_98213"]) expect(fragileId(id)).toBe(true);
    for (const id of ["search", "main-nav", "submit_button"]) expect(fragileId(id)).toBe(false);
    for (const name of ["css-1x2y3z", "sc-bdVaJa1", "jsx-2837465", "_3xYz1", "x1lliihq"]) expect(fragileClass(name)).toBe(true);
    for (const name of ["btn", "btnPrimary", "primary", "nav-link", "_hidden"]) expect(fragileClass(name)).toBe(false);
    expect(fragileSelector({ by: "css", value: "#ember1234 > button" })).toContain("generated id");
    expect(fragileSelector({ by: "css", value: "div.css-1x2y3z button" })).toContain("hashed class");
    expect(fragileSelector({ by: "css", value: "form#search > button.primary" })).toBeNull();
    expect(fragileSelector({ by: "xpath", value: "//div[@id='a3f9c2e1b7d4']/button" })).toContain("generated id");
  });

  test("values from one run are refused", () => {
    expect(hardcodedValue("Order for ana@example.com", [])).toContain("email");
    expect(hardcodedValue("Booked 2026-11-23", [])).toContain("date");
    expect(hardcodedValue("Results for running shoes", ["running shoes"])).toContain("{{param}}");
    expect(hardcodedValue("Ticket 48213377", [])).toContain("long number");
    expect(hardcodedValue("Search", [])).toBeNull();
    expect(candidateProblem({ by: "text", value: "Results for running shoes" }, ["running shoes"])).toContain("one run");
    expect(candidateProblem({ by: "role", value: "button", name: "Save" })).toBeNull();
    expect(candidateProblem({ by: "role", value: "button" })).toContain("role and a name");
  });

  test("a fingerprint needs a role and a stable name", () => {
    expect(fingerprintOf({ role: "button", name: "  Add   to cart " })).toEqual({ role: "button", name: "Add to cart" });
    expect(fingerprintOf({ role: "button", name: "Order 2026-01-02" })).toBeNull();
    expect(fingerprintOf({ role: null, name: "Go" })).toBeNull();
  });

  test("role and name match is exact first, then case and spacing, and never guesses between several", () => {
    const nodes = [
      { ref: "e1", role: "button", name: "Save" },
      { ref: "e2", role: "button", name: "save draft" },
      { ref: "e3", role: "link", name: "Save" },
      { ref: "e4", role: "button", name: "Delete" },
      { ref: "e5", role: "button", name: "delete" },
    ];
    expect(matchFingerprint({ role: "button", name: "Save" }, nodes)).toEqual({ ref: "e1", why: "exact role and name" });
    expect(matchFingerprint({ role: "button", name: "SAVE  DRAFT" }, nodes).ref).toBe("e2");
    expect(matchFingerprint({ role: "button", name: "DELETE" }, nodes).ref).toBeNull();
    expect(matchFingerprint({ role: "checkbox", name: "Save" }, nodes).why).toContain("no checkbox");
  });
});

describe("actions", () => {
  test("a logged replay becomes an action with candidates, fingerprint, intent and desired state", () => {
    const byRole = actionFromReplay(["find", "role", "button", "click", "--name", "Find", "--exact"]) as Action;
    expect(byRole.fingerprint).toEqual({ role: "button", name: "Find" });
    expect(byRole.candidates).toEqual([{ by: "role", value: "button", name: "Find" }]);
    expect(byRole.intent).toBe('click the "Find" button');
    const fill = actionFromReplay(["fill", '[placeholder="Search…"]', "{{query}}"]) as Action;
    expect(fill.candidates).toEqual([{ by: "placeholder", value: "Search…" }]);
    expect(fill.value).toBe("{{query}}");
    expect(fill.intent).toContain("{{query}}");
    expect((actionFromReplay(["check", "#terms"]) as Action).desired_state).toBe(true);
    expect((actionFromReplay(["uncheck", "#terms"]) as Action).desired_state).toBe(false);
    expect(actionFromReplay(["click", "#ember1234"])?.candidates).toEqual([]);
    expect(actionFromReplay(["scroll", "down", "300"])?.argv).toEqual(["scroll", "down", "300"]);
    expect(actionFromReplay(["eval", "1"])).toBeNull();
  });

  test("selectors parse into the locator kinds they are", () => {
    expect(candidatesFromSelector('input[name="q"]')).toEqual([{ by: "name", value: "q", tag: "input" }]);
    expect(candidatesFromSelector("[aria-label='Close dialog']")).toEqual([{ by: "aria-label", value: "Close dialog" }]);
    expect(candidatesFromSelector('text="Sign in"')).toEqual([{ by: "text", value: "Sign in" }]);
    expect(candidatesFromSelector('role=button[name="Go"]')).toEqual([{ by: "role", value: "button", name: "Go" }]);
    expect(candidatesFromSelector("xpath=//main/button[2]")).toEqual([{ by: "xpath", value: "//main/button[2]" }]);
    expect(candidatesFromSelector("main .card a")).toEqual([{ by: "css", value: "main .card a" }]);
  });

  test("argv per tier fills params and keeps the wanted state", () => {
    const fill: Action = { type: "fill", intent: "enter", candidates: [{ by: "name", value: "q", tag: "input" }], fingerprint: { role: "searchbox", name: "Search" }, value: "{{query}}" };
    expect(candidateArgv(fill, fill.candidates[0]!, { query: "boots" })).toEqual(["fill", 'input[name="q"]', "boots"]);
    expect(fingerprintArgv(fill, fill.fingerprint, { query: "boots" })).toEqual(["find", "role", "searchbox", "fill", "boots", "--name", "Search", "--exact"]);
    const toggle: Action = { type: "check", intent: "turn off", candidates: [{ by: "aria-label", value: "Emails" }], fingerprint: { role: "checkbox", name: "Emails" }, desired_state: false };
    expect(candidateArgv(toggle, toggle.candidates[0]!, {})).toEqual(["uncheck", '[aria-label="Emails"]']);
    expect(fingerprintArgv(toggle, toggle.fingerprint, {})).toEqual(["find", "role", "checkbox", "uncheck", "--name", "Emails", "--exact"]);
    const submit: Action = { type: "submit", intent: "submit", candidates: [{ by: "name", value: "q" }], fingerprint: null, value: "Enter" };
    expect(candidateArgv(submit, submit.candidates[0]!, {})).toEqual(["press", '[name="q"]', "Enter"]);
  });

  test("an action is checked like the rest of the flow file", () => {
    const params = new Set(["query"]);
    expect(actionProblem(searchAction(), params)).toBeNull();
    expect(actionProblem({ ...searchAction(), extra: 1 }, params)).toContain("fields");
    expect(actionProblem({ ...searchAction(), type: "eval" }, params)).toContain("unknown type");
    expect(actionProblem({ ...searchAction(), value: "{{other}}" }, params)).toContain("{{other}}");
    expect(actionProblem({ ...searchAction(), candidates: [{ by: "css", value: "#ember99812 > a" }] }, params)).toContain("isn't stable");
    expect(actionProblem({ ...searchAction(), candidates: [], fingerprint: null }, params)).toContain("no way to find");
    expect(actionProblem({ ...searchAction(), desired_state: "yes" }, params)).toContain("desired_state");
  });
});

describe("replay ladder", () => {
  test("the primary selector wins first", async () => {
    const driver = new FakeDriver(() => null);
    const outcome = await replayStep(driver, { seq: 2, action: searchAction() }, {});
    expect(outcome).toMatchObject({ ok: true, tier: "selector", candidate: 0 });
    expect(driver.ran).toEqual([["click", '[aria-label="Find"]']]);
  });

  test("a later candidate, then Escape and the candidates again, then role and name", async () => {
    const second = new FakeDriver((argv) => (argv[1] === '[aria-label="Find"]' ? missing() : null));
    expect(await replayStep(second, { seq: 2, action: searchAction() }, {})).toMatchObject({ ok: true, tier: "candidate", candidate: 1 });

    let escaped = false;
    const afterEscape = new FakeDriver((argv) => {
      if (argv[0] === "press" && argv[1] === "Escape") {
        escaped = true;
        return null;
      }
      return escaped ? null : new BrowseError("covered by a popover", null, "covered");
    });
    const escapedOutcome = await replayStep(afterEscape, { seq: 2, action: searchAction() }, {});
    expect(escapedOutcome).toMatchObject({ ok: true, tier: "escape", candidate: 0 });
    expect(afterEscape.ran.map((argv) => argv.join(" "))).toEqual(['click [aria-label="Find"]', "click form > button.primary", "press Escape", 'click [aria-label="Find"]']);

    const byRole = new FakeDriver((argv) => (argv[0] === "find" || (argv[0] === "press" && argv[1] === "Escape") ? null : missing()));
    const roleOutcome = await replayStep(byRole, { seq: 2, action: searchAction() }, {});
    expect(roleOutcome).toMatchObject({ ok: true, tier: "fingerprint" });
    expect(byRole.ran.at(-1)).toEqual(["find", "role", "button", "click", "--name", "Find", "--exact"]);
  });

  test("an unknown outcome is never retried", async () => {
    const driver = new FakeDriver(() => new OutcomeUnknown("click", "the page navigated"));
    const outcome = await replayStep(driver, { seq: 2, action: searchAction() }, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.fatal).toContain("outcome of click is unknown");
    expect(driver.ran).toHaveLength(1);
  });

  test("a step every tier misses stops the run with a fallback episode and a redacted snapshot", async () => {
    const driver = new FakeDriver((argv) => (argv[0] === "press" || argv[0] === "open" ? null : missing()));
    const steps = [
      { seq: 1, action: { type: "open", intent: "open the start page", candidates: [], fingerprint: null, value: "https://shop.example.com/" } as Action },
      { seq: 2, action: searchAction() },
      { seq: 3, action: { ...searchAction(), intent: "never reached" } },
    ];
    const report = await replay(driver, { name: "find", site: "example.com" }, steps, {}, ["secret-value-123"], () => "2026-11-23T00:00:00Z");
    expect(report.ok).toBe(false);
    expect(report.outcomes.map((outcome) => outcome.seq)).toEqual([1, 2]);
    const episode = report.episodes.at(-1)!;
    expect(episode).toMatchObject({ kind: "fallback", seq: 2, intent: 'click the "Find" button', fingerprint: { role: "button", name: "Find" }, at: "2026-11-23T00:00:00Z" });
    expect(episode.tried.map((item) => item.tier)).toEqual(["selector", "candidate", "escape", "escape", "fingerprint"]);
    expect(episode.snapshot).toContain('button "Find"');
    expect(episode.snapshot).not.toContain("secret-value-123");
  });

  test("a step that needs a param it wasn't given stops before acting", async () => {
    const driver = new FakeDriver(() => null);
    const fill: Action = { type: "fill", intent: "enter", candidates: [{ by: "name", value: "q" }], fingerprint: null, value: "{{query}}" };
    const outcome = await replayStep(driver, { seq: 2, action: fill }, {});
    expect(outcome.fatal).toContain("--param query=");
    expect(driver.ran).toHaveLength(0);
  });
});

function recordedSteps(body: string) {
  return [
    { seq: 1, command: ["open", "https://shop.example.com/"], before: "about:blank", replay: ["open", "https://shop.example.com/"], url: "https://shop.example.com/", ok: true, origins: [], unkept: [], requests: [] },
    {
      seq: 2,
      command: ["fill", '[placeholder="Search"]', "boots"],
      before: "https://shop.example.com/",
      replay: ["fill", '[placeholder="Search"]', "boots"],
      url: "https://shop.example.com/",
      ok: true,
      origins: [],
      unkept: [],
      requests: [],
      typed: { value: "boots", field: "search" },
    },
    {
      seq: 3,
      command: ["click", "@e4"],
      before: "https://shop.example.com/",
      replay: ["find", "role", "button", "click", "--name", "Find", "--exact"],
      url: "https://shop.example.com/s?q=boots",
      ok: true,
      origins: [],
      unkept: [],
      requests: body
        ? [{ id: "s3r1", method: "GET", url: "https://shop.example.com/api/search?q=boots", type: "Fetch", status: 200, mime: "application/json", headers: {}, strippedAuth: false, kind: "json", bytes: body.length, text: body }]
        : [],
    },
  ];
}

describe("flow save v2", () => {
  test("--actions on a range with no JSON answer saves an action flow that validates and loads", () => {
    expect(() => buildFlow("find", recordedSteps("") as never)).toThrow("Nothing to save");
    const [flow] = buildFlow("find", recordedSteps("") as never, {}, null, "find boots", "9.9.9", [], true);
    expect(flow["version"]).toBe(2);
    expect(flow["kind"]).toBe("actions");
    expect(flow["output"]).toBeNull();
    expect(flow["params"]).toEqual([{ name: "search", example: null, source: "typed" }]);
    const fill = flow["steps"][1]["action"] as Action;
    expect(fill).toMatchObject({ type: "fill", value: "{{search}}", candidates: [{ by: "placeholder", value: "Search" }] });
    expect(flow["steps"][2]["action"]["fingerprint"]).toEqual({ role: "button", name: "Find" });
    const root = tempDir();
    save(root, validate(flow));
    expect(load(root, "example.com", "find")["kind"]).toBe("actions");
    expect(runLocal(root, ["show", "find"]).text).toContain('click the "Find" button (by role=button[name="Find"] | role button "Find")');
  });

  test("a range with a JSON answer stays a version 1 request flow unless --actions", () => {
    const body = '{"items": [{"id": 1, "title": "Boot"}]}';
    const [plain] = buildFlow("find", recordedSteps(body) as never);
    expect(plain["version"]).toBe(1);
    expect(plain["steps"].some((step: Record<string, unknown>) => "action" in step)).toBe(false);
    const [both] = buildFlow("find", recordedSteps(body) as never, {}, null, null, "", [], true);
    expect(both).toMatchObject({ version: 2, kind: "requests", output: "s3r1" });
    expect(both["steps"][2]["action"]["type"]).toBe("click");
    validate(both);
  });

  test("a typed secret becomes a param with no value kept", () => {
    const steps = recordedSteps("");
    steps[1]!.typed = { value: "hunter22", field: "password", secret: true } as never;
    steps[1]!.replay = ["fill", '[name="password"]', "hunter22"];
    steps[1]!.command = ["fill", '[name="password"]', "hunter22"];
    const [flow] = buildFlow("login", steps as never, {}, null, null, "", [], true);
    expect(JSON.stringify(flow)).not.toContain("hunter22");
    expect(flow["params"]).toContainEqual({ name: "password", example: null, source: "secret" });
    expect(flow["steps"][1]["action"]["value"]).toBe("{{password}}");
  });

  test("an action flow with an off-site open, a bad action or a page command is refused on load", () => {
    const [flow] = buildFlow("find", recordedSteps("") as never, {}, null, null, "", [], true);
    const offSite = structuredClone(flow);
    offSite["steps"][0]["action"]["value"] = "https://evil.test/";
    expect(() => validate(offSite)).toThrow("open step on a host it doesn't list");
    const sneaky = structuredClone(flow);
    sneaky["steps"][0]["action"] = { type: "scroll", intent: "x", candidates: [], fingerprint: null, argv: ["eval", "alert(1)"] };
    expect(() => validate(sneaky)).toThrow("command isn't its action");
    const v1 = structuredClone(flow);
    v1["version"] = 1;
    expect(() => validate(v1)).toThrow(BrowseError);
    const kindless = structuredClone(flow);
    delete kindless["kind"];
    expect(() => validate(kindless)).toThrow("is version '2'; this ardia reads version 1.");
  });
});

describe("flow heal", () => {
  function saved(): [string, Record<string, any>] {
    const root = tempDir();
    const [flow] = buildFlow("find", recordedSteps("") as never, { search: "boots" }, null, null, "", [], true);
    flow["steps"][2]["action"]["candidates"] = [{ by: "css", value: "form > button.go" }];
    save(root, validate(flow));
    return [root, flow];
  }

  test("a fingerprint hit is proposed and --apply promotes role and name", () => {
    const [root, flow] = saved();
    addEpisodes(root, "example.com", "find", [
      { kind: "healed", at: "t", flow: "find", site: "example.com", seq: 3, type: "click", intent: "x", url: "", tier: "fingerprint", candidate: null, fingerprint: { role: "button", name: "Find" }, tried: [] },
    ]);
    expect(proposals(flow, loadEpisodes(root, "example.com", "find"))[0]!.candidates[0]).toEqual({ by: "role", value: "button", name: "Find" });
    const listed = runLocal(root, ["heal", "find"]);
    expect(listed.text).toContain("proposal for step 3");
    const applied = runLocal(root, ["heal", "find", "--apply"]);
    expect(applied.text).toContain("✓ Healed find");
    expect(load(root, "example.com", "find")["steps"][2]["action"]["candidates"][0]).toEqual({ by: "role", value: "button", name: "Find" });
    expect(loadEpisodes(root, "example.com", "find")).toEqual([]);
  });

  test("a later candidate that matched is moved first", () => {
    const [, flow] = saved();
    flow["steps"][2]["action"]["candidates"] = [{ by: "css", value: "form > button.go" }, { by: "text", value: "Find" }];
    const changes = proposals(flow, [{ kind: "healed", at: "t", flow: "find", site: "example.com", seq: 3, type: "click", intent: "x", url: "", tier: "candidate", candidate: 1, matched: { by: "text", value: "Find" }, fingerprint: null, tried: [] }]);
    expect(changes[0]!.candidates.map((candidate) => candidate.by)).toEqual(["text", "css"]);
  });

  test("a supplied selector is applied; generated ids and run values are refused", () => {
    const [root] = saved();
    expect(runLocal(root, ["heal", "find", "--step", "3", "--selector", '[aria-label="Find"]']).text).toContain('[aria-label="Find"]');
    expect(load(root, "example.com", "find")["steps"][2]["action"]["candidates"][0]).toEqual({ by: "aria-label", value: "Find" });
    for (const selector of ["#ember88123 button", "div.css-9xk2b1 > button", "text=Results for boots", "[data-testid='550e8400-e29b-41d4-a716-446655440000']"]) {
      try {
        runLocal(root, ["heal", "find", "--step", "3", "--selector", selector]);
        throw new Error(`accepted ${selector}`);
      } catch (error) {
        expect(error).toBeInstanceOf(BrowseError);
        expect((error as BrowseError).code).toBe("heal_rejected");
      }
    }
    expect(runValues(load(root, "example.com", "find"))).toContain("boots");
  });

  test("a value a run was given is refused even though the flow never kept it", () => {
    const [, flow] = saved();
    const episodes = [{ kind: "fallback" as const, at: "t", flow: "find", site: "example.com", seq: 3, type: "click", intent: "x", url: "", tier: null, candidate: null, fingerprint: null, tried: [], values: { search: "hats" } }];
    expect(applyPatch(flow, { steps: [{ seq: 3, selector: "text=Results for hats" }] }, episodes).rejected[0]!.why).toContain('"hats"');
    expect(applyPatch(flow, { steps: [{ seq: 3, selector: "text=Results for hats" }] }).rejected).toEqual([]);
  });

  test("a patch file sets candidates and a fingerprint at once", () => {
    const [, flow] = saved();
    const { flow: next, changes, rejected } = applyPatch(flow, {
      steps: [{ seq: 3, candidates: [{ by: "testid", value: "search-go" }], fingerprint: { role: "button", name: "Search" } }],
    });
    expect(rejected).toEqual([]);
    expect(changes).toHaveLength(1);
    expect(next["steps"][2]["action"]["candidates"][0]).toEqual({ by: "testid", value: "search-go" });
    expect(next["steps"][2]["action"]["fingerprint"]).toEqual({ role: "button", name: "Search" });
    expect(applyPatch(flow, { steps: [{ seq: 1, selector: "#go" }] }).rejected[0]!.why).toContain("no recorded element action");
  });
});

describe("drift and fixtures", () => {
  const value = pyLoads('{"data": {"items": [{"id": 1, "title": "Boot", "price": 3.5}]}, "total": 1}');

  test("the drift report lists every change, and lost item fields are named", () => {
    const recorded = { data: { items: [{ id: "number", title: "string", price: "number" }] }, total: "number", next: "string" };
    const now = pyLoads('{"data": {"items": [{"id": "1", "title": "Boot"}]}, "total": "1"}');
    expect(driftReport(recorded, now)).toEqual(["data.items[0].id was a number, now a string", "data.items[0].price is missing", "total was a number, now a string", "next is missing"]);
    expect(lostFields(["id", "title", "price"], now, "data.items")).toEqual(["price"]);
    expect(shapeDrift({ signature: recorded, list: "data.gone", itemFields: [] }, value)).toContain("the list data.gone is gone");
  });

  test("a document flow's fixture keeps the JSON block, drops other scripts and secrets, and its test runs offline", () => {
    const html =
      '<html><head><style>.a{}</style><script>trackUser("tok-secret-9")</script>' +
      '<script id="__NEXT_DATA__" type="application/json">{"props": {"items": [{"id": 1, "title": "Boot"}, {"id": 2, "title": "Shoe"}]}}</script>' +
      "</head><body>tok-secret-9</body></html>";
    expect(fixturePage(html, ["tok-secret-9"])).not.toContain("tok-secret-9");
    expect(fixturePage(html)).toContain("__NEXT_DATA__");
    expect(fixturePage(html)).not.toContain("trackUser");
    const flow = { name: "find", site: "example.com" };
    const request = {
      id: "s1r1",
      kind: "document",
      expect: { signature: { props: { items: [{ id: "number", title: "string" }] } }, list: "props.items", itemFields: ["id", "title"], extract: { scriptId: "__NEXT_DATA__" } },
    };
    const files = fixtureFiles(flow, request, html, ["tok-secret-9"]);
    expect(Object.keys(files).sort()).toEqual(["extract.mjs", "extract.test.mjs", "flow.json", "page.html"]);
    for (const text of Object.values(files)) expect(text).not.toMatch(/^\s*\/\/|\/\*/mu);
    const dir = path.join(tempDir(), "fixture");
    const written = writeFixture(dir, files);
    expect(written).toHaveLength(4);
    expect(fs.statSync(path.join(dir, "page.html")).mode & 0o777).toBe(0o600);
    const ran = spawnSync(process.execPath, ["test", path.join(dir, "extract.test.mjs")], { encoding: "utf8", cwd: dir });
    expect(ran.status).toBe(0);
    fs.writeFileSync(path.join(dir, "page.html"), html.replace('"title": "Boot"', '"name": "Boot"').replace('"title": "Shoe"', '"name": "Shoe"'));
    const drifted = spawnSync(process.execPath, ["test", path.join(dir, "extract.test.mjs")], { encoding: "utf8", cwd: dir });
    expect(drifted.status).not.toBe(0);
  });

  test("a JSON flow's fixture extracts the list straight from the answer", async () => {
    const request = { id: "s1r1", kind: "json", expect: { signature: { data: { items: [{ id: "number", title: "string", price: "number" }] }, total: "number" }, list: "data.items", itemFields: ["id", "title", "price"] } };
    const files = fixtureFiles({ name: "find" }, request, '{"data": {"items": [{"id": 1, "title": "Boot", "price": 3.5}]}, "total": 1}');
    const dir = path.join(tempDir(), "json-fixture");
    writeFixture(dir, files);
    const module = await import(path.join(dir, "extract.mjs"));
    expect(module.check(fs.readFileSync(path.join(dir, "answer.json"), "utf8"))).toEqual([]);
    expect(module.items(fs.readFileSync(path.join(dir, "answer.json"), "utf8"))).toHaveLength(1);
    expect(module.check('{"data": {"items": [{"id": "1", "title": "Boot"}]}, "total": 1}')).toEqual(["data.items[0].id was a number, now a string", "data.items[0].price is missing", "items in data.items lost price"]);
  });
});
