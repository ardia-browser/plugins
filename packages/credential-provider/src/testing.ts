import type { Ardia, PluginDefinition } from "@ardia/plugin-sdk";
import { createMockHost, type MockHost } from "@ardia/plugin-sdk/testing";
import { CREDENTIALS_SERVICE, PREFERENCES_KEY, SCRATCH_KEY, STORED_SESSION_KEY } from "./constants";
import { createSidecarCore, SidecarRefusal, type SidecarCore } from "./core";
import { isRecord } from "./data";
import { serviceMethod, type CredentialProviderOptions } from "./runtime";
import type { Awaitable, CliSpec, CredentialAnswer, Launch, Launcher, LaunchOutcome, StreamLine } from "./types";

export type FakeReply = {
  status?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  launched?: boolean;
  lines?: readonly StreamLine[];
  finishAfterMs?: number;
};

export type FakeCli = (launch: Launch) => Awaitable<FakeReply>;

export type FakeSidecar = {
  readonly core: SidecarCore;
  readonly launches: readonly Launch[];
  readonly refused: readonly { method: string; code: string; reason: string }[];
  readonly requests: readonly { method: string; params: unknown }[];
  installed: boolean;
  respond(params: Record<string, unknown>): Promise<unknown>;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer: { unref?: () => void } = setTimeout(resolve, ms) as unknown as { unref?: () => void };
    timer.unref?.();
  });

export function fakeLauncher(cli: FakeCli, launches: Launch[] = []): Launcher {
  return async (launch, io): Promise<LaunchOutcome> => {
    launches.push(launch);
    let reply: FakeReply;
    try {
      reply = await cli(launch);
    } catch {
      return { launched: false, status: -1, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: false };
    }
    if (reply.launched === false) return { launched: false, status: -1, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: false };
    for (const line of reply.lines ?? []) io.onLine(line);
    let cancelled = false;
    const wait = reply.finishAfterMs ?? 0;
    if (wait > 0) {
      const timedOutAt = wait > launch.timeoutMs;
      await Promise.race([sleep(Math.min(wait, launch.timeoutMs)), io.cancelled.then(() => void (cancelled = true))]);
      if (!cancelled && timedOutAt) return { launched: true, status: -1, stdout: "", stderr: reply.stderr ?? "", timedOut: true, overflowed: false, cancelled: false };
    }
    if (cancelled) return { launched: true, status: -1, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: true };
    const streamed = (reply.lines ?? []).filter((line) => line.stream === "stdout").map((line) => `${line.text}\n`).join("");
    return { launched: true, status: reply.status ?? 0, stdout: `${streamed}${reply.stdout ?? ""}`, stderr: reply.stderr ?? "", timedOut: reply.timedOut === true, overflowed: false, cancelled: false };
  };
}

export function fakeSidecar(spec: CliSpec, cli: FakeCli, options: { installed?: boolean; session?: { key: string | null } } = {}): FakeSidecar {
  const launches: Launch[] = [];
  const refused: { method: string; code: string; reason: string }[] = [];
  const requests: { method: string; params: unknown }[] = [];
  const fake: FakeSidecar = {
    core: createSidecarCore(spec, fakeLauncher(cli, launches), { programFound: () => fake.installed, ...(options.session ? { session: options.session } : {}) }),
    launches,
    refused,
    requests,
    installed: options.installed ?? true,
    async respond(params) {
      const method = typeof params.method === "string" ? params.method : "";
      requests.push({ method, params: params.params });
      try {
        return await fake.core.handle(method, isRecord(params.params) ? params.params : {});
      } catch (error) {
        if (error instanceof SidecarRefusal) refused.push({ method, code: error.code, reason: error.message });
        throw error;
      }
    },
  };
  return fake;
}

export const cliReply = {
  json: (value: unknown): FakeReply => ({ stdout: JSON.stringify(value) }),
  lines: (...lines: string[]): FakeReply => ({ stdout: lines.map((line) => `${line}\n`).join("") }),
  failed: (stderr: string, status = 1): FakeReply => ({ status, stderr }),
};

export type PluginFactory = (ardia: Ardia, overrides?: Partial<CredentialProviderOptions>) => PluginDefinition;

export type HarnessOptions = {
  plugin: PluginFactory;
  spec: CliSpec;
  cli: FakeCli;
  id?: string;
  session?: { key: string | null } | null;
  preferences?: Record<string, string>;
  scratch?: Record<string, string>;
  storedSession?: string;
  touchID?: boolean;
  offline?: boolean;
  installed?: boolean;
  confirms?: boolean;
};

export type CredentialHarness = {
  readonly host: MockHost;
  readonly sidecar: FakeSidecar;
  readonly context: { touchID: boolean; offline: boolean };
  call<T = unknown>(name: string, input?: unknown): Promise<CredentialAnswer<T>>;
  lines(): string[];
  readonly launches: readonly Launch[];
  readonly preferences: Readonly<Record<string, string>>;
  readonly scratch: Readonly<Record<string, string>>;
  readonly storedSession: string | null;
  readonly unlocked: boolean;
};

const recordAt = (host: MockHost, key: string): Record<string, string> => {
  const value = host.storage.get(key);
  return isRecord(value) ? (value as Record<string, string>) : {};
};

export async function credentialHarness(options: HarnessOptions): Promise<CredentialHarness> {
  const sidecar = fakeSidecar(options.spec, options.cli, { installed: options.installed ?? true, ...(options.session ? { session: options.session } : {}) });
  const host = createMockHost({ plugin: options.id ?? "@test/credentials" });
  if (options.preferences) host.storage.set(PREFERENCES_KEY, { ...options.preferences });
  if (options.scratch) host.storage.set(SCRATCH_KEY, { ...options.scratch });
  if (options.storedSession) host.secrets.set(STORED_SESSION_KEY, options.storedSession);
  host.respond("sidecar.request", (params) => sidecar.respond(params));
  host.respond("ui.showConfirm", () => ({ confirmed: options.confirms ?? true }));
  const context = { touchID: options.touchID ?? false, offline: options.offline ?? false };
  await host.load(options.plugin(host.ardia, { callContext: () => context }));
  return {
    host,
    sidecar,
    context,
    call: <T>(name: string, input?: unknown) => host.callService<CredentialAnswer<T>>(CREDENTIALS_SERVICE, serviceMethod(name), input ?? {}),
    lines: () => sidecar.launches.map((launch) => launch.argv.join(" ")),
    get launches() {
      return sidecar.launches;
    },
    get preferences() {
      return recordAt(host, PREFERENCES_KEY);
    },
    get scratch() {
      return recordAt(host, SCRATCH_KEY);
    },
    get storedSession() {
      return host.secrets.get(STORED_SESSION_KEY) ?? null;
    },
    get unlocked() {
      return sidecar.core.unlocked;
    },
  };
}
