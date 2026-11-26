import { afterEach, describe, expect, test } from "bun:test";
import { Found } from "../src/browse/args.ts";
import { environmentIsText, envSession, Refused, sessionName } from "../src/browse/request.ts";
import { autoSessionsOn } from "../src/browse/serve.ts";
import { SessionDaemon } from "../src/mcp/index.ts";

const ENV_KEYS = ["ARDIA_SESSION", "AGENT_BROWSER_SESSION", "ARDIA_BROWSE_AUTO_SESSION", "ARDIA_BROWSE_FOR_PLUGIN"] as const;

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe("ARDIA_SESSION environment variable", () => {
  const baseline = saveEnv();

  afterEach(() => {
    restoreEnv(baseline);
  });

  test("envSession prefers ARDIA_SESSION over AGENT_BROWSER_SESSION and falls back when empty", () => {
    expect(envSession({ ARDIA_SESSION: "work", AGENT_BROWSER_SESSION: "legacy" })).toBe("work");
    expect(envSession({ ARDIA_SESSION: "", AGENT_BROWSER_SESSION: "legacy" })).toBe("legacy");
    expect(envSession({ AGENT_BROWSER_SESSION: "legacy" })).toBe("legacy");
    expect(envSession({})).toBeUndefined();
  });

  test("sessionName honors --session > ARDIA_SESSION > AGENT_BROWSER_SESSION > default", () => {
    delete process.env["ARDIA_SESSION"];
    delete process.env["AGENT_BROWSER_SESSION"];
    expect(sessionName(new Found())).toBe("default");

    process.env["AGENT_BROWSER_SESSION"] = "legacy";
    expect(sessionName(new Found())).toBe("legacy");

    process.env["ARDIA_SESSION"] = "isolated";
    expect(sessionName(new Found())).toBe("isolated");

    const explicit = new Found();
    explicit.values.set("session", "flag-wins");
    expect(sessionName(explicit)).toBe("flag-wins");
  });

  test("sessionName rejects invalid ARDIA_SESSION values", () => {
    process.env["ARDIA_SESSION"] = "../bad";
    expect(() => sessionName(new Found())).toThrow(Refused);
  });

  test("ARDIA_SESSION disables auto-sessions in browse and MCP", async () => {
    delete process.env["AGENT_BROWSER_SESSION"];
    delete process.env["ARDIA_BROWSE_AUTO_SESSION"];
    delete process.env["ARDIA_BROWSE_FOR_PLUGIN"];

    expect(autoSessionsOn(new Found())).toBe(true);

    process.env["ARDIA_SESSION"] = "pinned";
    expect(autoSessionsOn(new Found())).toBe(false);

    const claims: string[] = [];
    const found = new Found();
    found.values.set("port", "9333");
    const daemon = new SessionDaemon(found, undefined, () => "auto-should-not-win", async (_root, _ns, _key, id) => {
      claims.push(id);
      return { notice: null };
    });
    expect(daemon.session).toBe("pinned");
    expect(daemon.auto).toBeNull();
    await daemon.register();
    expect(claims).toEqual([]);
  });

  test("environmentIsText rejects lossy bytes in ARDIA_SESSION", () => {
    delete process.env["AGENT_BROWSER_SESSION"];
    process.env["ARDIA_SESSION"] = "ok-session";
    expect(environmentIsText()).toBe(true);

    process.env["ARDIA_SESSION"] = "bad\ufffd";
    expect(environmentIsText()).toBe(false);
  });
});
