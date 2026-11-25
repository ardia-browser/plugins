import { CREDENTIAL_LIMITS, SIDECAR_METHODS } from "./constants";
import { isRecord } from "./data";
import { buildVerb, effectiveTimeout } from "./launch";
import { redactable, redactText, verbOutcome } from "./output";
import type { CliSpec, CredentialVerb, Launcher, LaunchOutcome, RunReply, SecretHandle, SignInRunState, StatusReply, StreamLine, VerbParams } from "./types";

export class SidecarRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SidecarRefusal";
    this.code = code;
  }
}

export type SidecarCore = {
  handle(method: string, params: unknown): Promise<unknown>;
  readonly unlocked: boolean;
  readonly session: { readonly key: string | null } | null;
  dispose(): void;
};

export type SidecarCoreOptions = {
  now?: () => number;
  programFound?: () => boolean;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  session?: { key: string | null };
};

type Run = {
  id: string;
  verb: CredentialVerb;
  signIn: boolean;
  lines: StreamLine[];
  shown: number;
  finished: Promise<RunReply>;
  done: RunReply | null;
  cancel(): void;
  wake: Set<() => void>;
};

const NONE: SignInRunState = { state: "none", hints: [] };

export function createSidecarCore(spec: CliSpec, launcher: Launcher, options: SidecarCoreOptions = {}): SidecarCore {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const runs = new Map<string, Run>();
  let session: { key: string | null; at: number } | null = options.session ? { key: options.session.key, at: now() } : null;
  let offered: string | null = null;
  let signInRun: SignInRunState = NONE;
  let nextRun = 0;
  let active = 0;

  const current = () => {
    if (session && spec.sessionLastsSeconds !== null && now() - session.at > spec.sessionLastsSeconds * 1000) session = null;
    return session;
  };

  const lookup = (handle: SecretHandle) => (handle.$secret === "session" ? (current()?.key ?? null) : handle.$secret === "stored" ? offered : null);

  const status = (): StatusReply => ({ unlocked: current() !== null, signInRun, cli: { name: spec.name, found: options.programFound?.() ?? true } });

  function applyUnlock(verb: CredentialVerb, lastLine: string | null): boolean {
    if (!verb.unlocks) return false;
    if (verb.output.mode === "lastLineSecret") {
      if (!lastLine) return false;
      session = { key: lastLine, at: now() };
      return true;
    }
    session = { key: session?.key ?? null, at: now() };
    return true;
  }

  function runningReply(run: Run): RunReply {
    const lines = run.lines.slice(run.shown).filter((line) => line.stream === "stdout").map((line) => line.text);
    run.shown = run.lines.length;
    return {
      verb: run.id,
      status: -1,
      launched: true,
      timedOut: false,
      cancelled: false,
      overflowed: false,
      succeeded: false,
      stderr: run.lines.filter((line) => line.stream === "stderr").map((line) => line.text).join("\n"),
      hints: [],
      json: null,
      lines,
      items: 0,
      droppedLines: 0,
      unlocked: false,
      running: run.id,
      signInRun,
    };
  }

  function waitFor(run: Run, ms: number): Promise<void> {
    if (run.done || run.lines.length > run.shown) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimer(timer);
        run.wake.delete(wake);
        resolve();
      };
      const timer = setTimer(wake, ms);
      run.wake.add(wake);
    });
  }

  async function start(params: Record<string, unknown>): Promise<RunReply> {
    const verbId = typeof params.verb === "string" ? params.verb : "";
    const verbParams = (isRecord(params.params) ? params.params : {}) as VerbParams;
    const built = buildVerb(spec, verbId, verbParams, lookup);
    if (!("launch" in built)) throw new SidecarRefusal(built.code, built.message);
    if (active >= CREDENTIAL_LIMITS.runningVerbs) throw new SidecarRefusal("overloaded", `${spec.name} has ${CREDENTIAL_LIMITS.runningVerbs} commands running.`);
    const { verb, consumed, jsonStrings } = built;
    const launch = { ...built.launch, timeoutMs: effectiveTimeout(params.timeoutMs, built.launch.timeoutMs) };
    if (verb.signIn) {
      for (const other of runs.values()) if (other.signIn) other.cancel();
      signInRun = { state: "running", hints: [] };
    }
    const secrets = redactable(consumed, 3);
    let cancel: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    const run: Run = { id: `r${++nextRun}`, verb, signIn: verb.signIn, lines: [], shown: 0, finished: Promise.resolve(null as never), done: null, cancel, wake: new Set() };
    const notify = () => {
      for (const wake of [...run.wake]) wake();
    };
    active++;
    run.finished = launcher(launch, {
      onLine(line) {
        run.lines.push({ stream: line.stream, text: redactText(line.text, secrets) });
        notify();
      },
      cancelled,
    })
      .catch((): LaunchOutcome => ({ launched: false, status: -1, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: false }))
      .then((outcome) => {
        active--;
        const output = verbOutcome(verb, outcome, consumed, jsonStrings);
        const unlocked = output.succeeded && applyUnlock(verb, output.lastLine);
        if (verb.signIn) {
          const detail = output.succeeded ? undefined : output.stderr.split("\n").find((line) => line.trim())?.trim();
          signInRun = outcome.cancelled ? NONE : { state: output.succeeded ? "succeeded" : "failed", hints: output.hints, ...(detail ? { detail } : {}), ...(output.timedOut ? { timedOut: true } : {}) };
        }
        const { lastLine, ...body } = output;
        const persist = unlocked && typeof verb.unlocks === "object" && verb.unlocks.persistent && lastLine ? { persist: lastLine } : {};
        const reply: RunReply = { verb: verbId, ...body, unlocked, signInRun, ...persist };
        run.done = reply;
        runs.delete(run.id);
        notify();
        return reply;
      });
    if (verb.output.mode !== "stream") return run.finished;
    runs.set(run.id, run);
    await Promise.race([run.finished, waitFor(run, launch.timeoutMs)]);
    return run.done ?? runningReply(run);
  }

  async function wait(params: Record<string, unknown>): Promise<RunReply> {
    const id = typeof params.run === "string" ? params.run : "";
    const run = runs.get(id);
    if (!run) throw new SidecarRefusal("expired", `${id} isn't running.`);
    const ms = typeof params.waitMs === "number" && Number.isFinite(params.waitMs) ? Math.max(0, Math.min(params.waitMs, 30_000)) : 1_000;
    await waitFor(run, ms);
    return run.done ?? runningReply(run);
  }

  function cancelSignIn(): StatusReply {
    for (const run of runs.values()) if (run.signIn) run.cancel();
    signInRun = NONE;
    return status();
  }

  return {
    get unlocked() {
      return current() !== null;
    },
    get session() {
      const held = current();
      return held ? { key: held.key } : null;
    },
    async handle(method, raw) {
      const params = isRecord(raw) ? raw : {};
      switch (method) {
        case SIDECAR_METHODS.run:
          return start(params);
        case SIDECAR_METHODS.wait:
          return wait(params);
        case SIDECAR_METHODS.status:
          return status();
        case SIDECAR_METHODS.restore:
          if (typeof params.value !== "string" || !params.value || params.value.length > CREDENTIAL_LIMITS.secretBytes) throw new SidecarRefusal("bad_request", "session.restore takes the session's value.");
          session = { key: params.value, at: now() };
          return status();
        case SIDECAR_METHODS.offer:
          if (typeof params.value !== "string" || !params.value || params.value.length > CREDENTIAL_LIMITS.secretBytes) throw new SidecarRefusal("bad_request", "session.offer takes the stored session's value.");
          offered = params.value;
          return status();
        case SIDECAR_METHODS.adopt:
          if (offered === null) throw new SidecarRefusal("expired", "No stored session was offered.");
          session = { key: offered, at: now() };
          offered = null;
          return status();
        case SIDECAR_METHODS.open:
          session = { key: current()?.key ?? null, at: now() };
          return status();
        case SIDECAR_METHODS.drop:
          session = null;
          offered = null;
          return status();
        case SIDECAR_METHODS.cancelSignIn:
          return cancelSignIn();
        default:
          throw new SidecarRefusal("refused", `The ${spec.name} sidecar has no method ${method}.`);
      }
    },
    dispose() {
      for (const run of runs.values()) run.cancel();
      runs.clear();
      session = null;
      offered = null;
    },
  };
}
