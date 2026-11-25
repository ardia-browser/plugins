import { describe, expect, test } from "bun:test";
import { daemonEnvironment } from "../src/browse/daemon/spawn.ts";
import { Usage } from "../src/browse/args.ts";
import { checkEnvEndpoint, type Endpoint, endpointKey, splitUrl } from "../src/browse/request.ts";
import type { JsonObject, Value } from "../src/json.ts";

const ROOT = "/tmp/ardia-root";
const WS = "ws://127.0.0.1:9333/devtools/browser/abc?token=T0KENT0KENT0KEN";
const CDP = "ws://127.0.0.1:1/devtools/browser/q?token=T0KENT0KENT0KEN";
const NO_FLAGS: Endpoint = { ws: undefined, port: undefined, dataDir: undefined };

function wsKey(url: string): string {
  const parts = splitUrl(url);
  return `ws:${parts.scheme}://${parts.netloc}${parts.path}`;
}

// The key of the endpoint the daemon is handed: what daemonEnvironment() folds into its config, else the
// ARDIA_PORT it leaves for the daemon to refuse, else the control file under the data root.
function reachedKey(endpoint: Endpoint, environment: NodeJS.ProcessEnv): string {
  const config: JsonObject = new Map<string, Value>([["ws", endpoint.ws ?? null], ["port", endpoint.port ?? null]]);
  const { config: folded, env } = daemonEnvironment(config, environment);
  const ws = folded.get("ws");
  if (typeof ws === "string") return wsKey(ws);
  const port = folded.get("port");
  if (typeof port === "bigint") return `port:${port}`;
  if (env["ARDIA_PORT"] !== undefined) return `port:${env["ARDIA_PORT"]}`;
  return `token:${ROOT}`;
}

describe("endpointKey follows the endpoint the daemon reaches", () => {
  const cases: [string, Endpoint, NodeJS.ProcessEnv][] = [
    ["no endpoint", NO_FLAGS, {}],
    ["ARDIA_PORT", NO_FLAGS, { ARDIA_PORT: "9222" }],
    ["ARDIA_PORT read as Python reads an int", NO_FLAGS, { ARDIA_PORT: " +9_222 " }],
    ["ARDIA_PORT over ARDIA_CDP_URL", NO_FLAGS, { ARDIA_PORT: "9222", ARDIA_CDP_URL: CDP }],
    ["ARDIA_WS", NO_FLAGS, { ARDIA_WS: WS }],
    ["ARDIA_WS over ARDIA_PORT", NO_FLAGS, { ARDIA_WS: WS, ARDIA_PORT: "9222" }],
    ["ARDIA_CDP_URL", NO_FLAGS, { ARDIA_CDP_URL: CDP }],
    ["an invalid ARDIA_PORT", NO_FLAGS, { ARDIA_PORT: "nine", ARDIA_CDP_URL: CDP }],
    ["--port over ARDIA_PORT", { ...NO_FLAGS, port: 9333n }, { ARDIA_PORT: "9222", ARDIA_WS: WS }],
    ["--ws over ARDIA_PORT", { ...NO_FLAGS, ws: WS }, { ARDIA_PORT: "9222" }],
  ];
  for (const [name, endpoint, environment] of cases) {
    test(name, () => {
      expect(endpointKey(endpoint, ROOT, environment)).toBe(reachedKey(endpoint, environment));
    });
  }

  test("an ARDIA_PORT session doesn't share the native session's daemon", () => {
    const native = endpointKey(NO_FLAGS, ROOT, {});
    expect(endpointKey(NO_FLAGS, ROOT, { ARDIA_PORT: "9222" })).not.toBe(native);
    expect(endpointKey(NO_FLAGS, ROOT, { ARDIA_PORT: "nine" })).not.toBe(native);
    expect(endpointKey(NO_FLAGS, ROOT, { ARDIA_WS: WS })).not.toBe(native);
  });

  test("ARDIA_PORT and --port with the same port share a daemon", () => {
    expect(endpointKey(NO_FLAGS, ROOT, { ARDIA_PORT: "9222" })).toBe(endpointKey({ ...NO_FLAGS, port: 9222n }, ROOT, {}));
  });
});

describe("an ARDIA_PORT the daemon would refuse is refused before a session is claimed", () => {
  test("one that isn't a number", () => {
    expect(() => checkEnvEndpoint({ ARDIA_PORT: "nine" })).toThrow(new Usage("ARDIA_PORT must be a port number, not 'nine'"));
  });

  test("one out of range", () => {
    expect(() => checkEnvEndpoint({ ARDIA_PORT: "70000" })).toThrow(new Usage("ARDIA_PORT must be between 1 and 65535, not 70000"));
    expect(() => checkEnvEndpoint({ ARDIA_PORT: "0" })).toThrow(new Usage("ARDIA_PORT must be between 1 and 65535, not 0"));
  });

  test("a usable one, or one ARDIA_WS overrides", () => {
    for (const environment of [{}, { ARDIA_PORT: "9222" }, { ARDIA_PORT: "65535" }, { ARDIA_WS: WS, ARDIA_PORT: "nine" }, { ARDIA_CDP_URL: CDP }]) {
      expect(() => checkEnvEndpoint(environment)).not.toThrow();
    }
  });
});
