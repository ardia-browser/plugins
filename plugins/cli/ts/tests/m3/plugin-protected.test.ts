import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { methodsBetweenMarks, pluginViolations } from "./plugin-rules.ts";
import { type Asked, CHROME, CREDENTIAL, entries, pageTarget, resetPage, SECRET, startWorld, step, stopWorld, type World } from "./plugin-world.ts";

setDefaultTimeout(120_000);
const BASE = Number(process.env["ARDIA_F1_PORTS"] ?? "9660") + 25;
const MASK = /•{3,}/u;

describe.skipIf(!CHROME)("protected (password) fields in plugin mode", () => {
  let world: World;
  let loader = "";
  const replies: Asked[] = [];
  let refs: Record<string, string> = {};

  async function ask(name: string, argv: string[], options: Record<string, unknown> = {}): Promise<Asked> {
    const answer = await step(world, argv, { expect_loader: loader, ...options }, CREDENTIAL, world.key, name);
    replies.push(answer);
    return answer;
  }

  beforeAll(async () => {
    world = await startWorld(BASE);
    const target = await pageTarget(world);
    await resetPage(world, target, `http://127.0.0.1:${world.sitePort}/login`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const picked = await step(world, ["tab", target], { json: true });
    loader = String((JSON.parse(picked.out) as { data: { loader: string } }).data.loader);
    const shot = await ask("snapshot", ["snapshot", "-i"]);
    for (const [name, label] of [["user", "Username"], ["pw", "Password"], ["fpw", "Frame password"]] as const) {
      refs[name] = `@${/ref=(e\d+)/u.exec(shot.out.split("\n").find((line) => line.includes(`"${label}"`)) ?? "")?.[1] ?? ""}`;
    }
  });

  afterAll(async () => {
    if (world) await stopWorld(world);
  });

  test("snapshot shows the password fields as present, with role, name and (password field), and no value", async () => {
    const shot = await ask("snapshot again", ["snapshot", "-i"]);
    expect(shot.out).toMatch(/textbox "Username" \[ref=e\d+\]: ada/u);
    expect(shot.out).toMatch(/textbox "Password" \[ref=e\d+\] \(password field\)/u);
    expect(shot.out).toMatch(/textbox "Frame password" \[ref=e\d+\] \(password field\)/u);
    expect(shot.out).not.toMatch(MASK);
    const json = await ask("snapshot json", ["snapshot", "-c"], { json: true });
    expect(json.out).not.toMatch(MASK);
  });

  test("a username the page filled stays readable; get never returns a password", async () => {
    expect((await ask("get user", ["get", "value", refs["user"] as string])).out).toBe("ada\n");
    expect((await ask("get pw", ["get", "value", refs["pw"] as string])).out).toBe("(password field)\n");
    expect((await ask("get frame pw", ["get", "value", refs["fpw"] as string])).out).toBe("(password field)\n");
    expect((await ask("get attr", ["get", "attr", refs["pw"] as string, "value"])).out).toBe("\n");
    const html = await ask("get html", ["get", "html", "#login"]);
    expect(html.exit).toBe(0);
    expect(html.out).toContain('type="password"');
    expect((await ask("get text", ["get", "text", "#login"])).exit).toBe(0);
    expect((await ask("find text", ["find", "label", "Password", "text"])).exit).toBe(0);
  });

  test("fill and type into a password field are refused with 77 protected_field before any input", async () => {
    for (const [name, argv] of [
      ["fill pw", ["fill", "--", refs["pw"] as string, "guess"]],
      ["type pw", ["type", "--", refs["pw"] as string, "guess"]],
      ["fill frame pw", ["fill", "--", refs["fpw"] as string, "guess"]],
      ["find fill pw", ["find", "label", "Password", "fill", "guess"]],
    ] as const) {
      const refused = await ask(name, [...argv], { json: true });
      expect(refused).toMatchObject({ exit: 77, code: "protected_field" });
      expect(JSON.parse(refused.out)).toMatchObject({ error: "Password fields are filled by the password manager, not by plugins" });
      expect(refused.metrics?.["plugin_protected_refused"]).toBe(1);
      const sent = methodsBetweenMarks(entries(world)).get(name) ?? [];
      expect(sent.filter((method) => method.startsWith("Input.") || method === "Ardia.dispatchClick")).toEqual([]);
    }
  });

  test("a change report that touches the form shows the password field without a value [tap emulates Ardia.dispatchClick]", async () => {
    const filled = await ask("fill user", ["fill", "--", refs["user"] as string, "grace"]);
    expect(filled.exit).toBe(0);
    expect(filled.out).toContain("grace");
    expect(filled.out).not.toMatch(MASK);
  });

  test("the secret never appears in any reply or anything the daemon sent", () => {
    for (const answer of replies) expect(JSON.stringify(answer)).not.toContain(SECRET);
    const sent = entries(world).filter((entry) => entry.k === "out" || entry.k === "emulated");
    expect(sent.some((entry) => String(entry.m).includes(SECRET))).toBe(false);
    expect(pluginViolations(entries(world))).toEqual([]);
  });
});
