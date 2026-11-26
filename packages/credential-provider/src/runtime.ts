import type { Ardia, CallContext, PluginDefinition, ServiceHandlers } from "@ardia/plugin-sdk";
import {
  CREDENTIAL_HANDLERS,
  CREDENTIAL_LIMITS,
  CREDENTIALS_CONTRACT,
  CREDENTIALS_SERVICE,
  PREFERENCES_KEY,
  SCRATCH_KEY,
  SESSION_HANDLE,
  SIDECAR_METHODS,
  STORED_HANDLE,
  STORED_SESSION_KEY,
  STREAM_WAIT_MS,
} from "./constants";
import { isRecord, utf8Length } from "./data";
import { CredentialError, isSecretHandle, wireErrorOf } from "./errors";
import { itemsOf } from "./output";
import type {
  CliSpec,
  CredentialAnswer,
  CredentialContext,
  CredentialHandler,
  CredentialHandlerName,
  CredentialProvider,
  ItemPage,
  ListedItem,
  ListRequest,
  ProviderDescription,
  ProviderInfo,
  RunReply,
  SecretHandle,
  SignInRunState,
  StatusReply,
  ValueStore,
  VerbOptions,
  VerbParams,
  VerbResult,
} from "./types";

export type CredentialProviderOptions = {
  id: string;
  spec: CliSpec;
  info: ProviderInfo;
  provider: CredentialProvider;
  persistSessions?: boolean;
  callContext?: (call: CallContext) => { touchID: boolean; offline: boolean };
  now?: () => number;
};

const contextFromCall = (call: CallContext) => ({ touchID: call.context.touchID === true, offline: call.context.offline === true });

type HeldListing = { pages: ListedItem[][]; touched: number };

type AnyHandler = CredentialHandler<never, unknown>;

const PAGE_ENVELOPE_BYTES = 512;

function handlerOf(provider: CredentialProvider, name: CredentialHandlerName): AnyHandler | undefined {
  if (name === "passkeys.list") return provider.passkeys?.list as AnyHandler | undefined;
  if (name === "passkeys.get") return provider.passkeys?.get as AnyHandler | undefined;
  if (name === "passkeys.save") return provider.passkeys?.save as AnyHandler | undefined;
  const handler = provider[name];
  return typeof handler === "function" ? (handler as AnyHandler) : undefined;
}

export const serviceMethod = (name: string) => name.replace(/\.([a-z])/g, (_dot, letter: string) => letter.toUpperCase());

export function credentialHandlersOf(provider: CredentialProvider): CredentialHandlerName[] {
  return CREDENTIAL_HANDLERS.filter((name) => handlerOf(provider, name) !== undefined);
}

export function pageItems(items: readonly ListedItem[], pageBytes: number = CREDENTIAL_LIMITS.pageBytes): ListedItem[][] {
  const pages: ListedItem[][] = [];
  let page: ListedItem[] = [];
  let bytes = PAGE_ENVELOPE_BYTES;
  for (const item of items) {
    const size = utf8Length(JSON.stringify(item)) + 1;
    if (page.length && bytes + size > pageBytes) {
      pages.push(page);
      page = [];
      bytes = PAGE_ENVELOPE_BYTES;
    }
    page.push(item);
    bytes += size;
  }
  pages.push(page);
  return pages;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

function signInRunOf(value: unknown): SignInRunState {
  if (!isRecord(value)) return { state: "none", hints: [] };
  const state = value.state;
  if (state !== "none" && state !== "running" && state !== "succeeded" && state !== "failed") return { state: "none", hints: [] };
  return { state, hints: strings(value.hints), ...(typeof value.detail === "string" ? { detail: value.detail } : {}), ...(value.timedOut === true ? { timedOut: true } : {}) };
}

function statusOf(value: unknown): StatusReply {
  const record = isRecord(value) ? value : {};
  const cli = isRecord(record.cli) ? record.cli : {};
  return { unlocked: record.unlocked === true, signInRun: signInRunOf(record.signInRun), cli: { name: typeof cli.name === "string" ? cli.name : "", found: cli.found !== false } };
}

function replyOf(verb: string, value: unknown): RunReply {
  const record = isRecord(value) ? value : {};
  const flag = (key: string) => record[key] === true;
  const count = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : 0);
  return {
    verb,
    status: typeof record.status === "number" ? record.status : -1,
    launched: flag("launched"),
    timedOut: flag("timedOut"),
    cancelled: flag("cancelled"),
    overflowed: flag("overflowed"),
    succeeded: flag("succeeded"),
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    hints: strings(record.hints),
    json: record.json ?? null,
    lines: strings(record.lines),
    items: count("items"),
    droppedLines: count("droppedLines"),
    unlocked: flag("unlocked"),
    signInRun: signInRunOf(record.signInRun),
    ...(typeof record.running === "string" ? { running: record.running } : {}),
    ...(typeof record.persist === "string" ? { persist: record.persist } : {}),
  };
}

const resultOf = ({ running: _running, persist: _persist, signInRun: _run, ...result }: RunReply): VerbResult => result;

function textValues(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
  return out;
}

export function createCredentialProvider(ardia: Ardia, options: CredentialProviderOptions): PluginDefinition {
  const { id, spec, info, provider } = options;
  const now = options.now ?? (() => Date.now());
  const handlers = credentialHandlersOf(provider);
  const held = new Map<string, HeldListing>();
  let snapshots = 0;

  const sidecar = (method: string, params?: unknown) => ardia.sidecar.request(method, params);

  async function valueStore(key: string): Promise<ValueStore> {
    const values = textValues(await ardia.storage.get(key));
    return {
      get: (name) => values[name],
      async set(name, value) {
        if (value === null) delete values[name];
        else {
          if (Object.keys(values).length >= CREDENTIAL_LIMITS.valueKeys && !(name in values)) throw CredentialError.failed("failed", { detail: `${info.title} keeps at most ${CREDENTIAL_LIMITS.valueKeys} values.` });
          if (utf8Length(value) > CREDENTIAL_LIMITS.valueBytes) throw CredentialError.failed("failed", { detail: `${name} is longer than ${CREDENTIAL_LIMITS.valueBytes} bytes.` });
          values[name] = value;
        }
        await ardia.storage.set(key, { ...values });
      },
    };
  }

  async function contextFor(name: CredentialHandlerName, call: CallContext): Promise<{ ctx: CredentialContext; status: StatusReply; end(): void }> {
    const status = statusOf(await sidecar(SIDECAR_METHODS.status));
    const { touchID, offline } = (options.callContext ?? contextFromCall)(call);
    const persists = options.persistSessions === true;
    const [preferences, scratch, stored] = await Promise.all([valueStore(PREFERENCES_KEY), valueStore(SCRATCH_KEY), persists && touchID ? ardia.secrets.get(STORED_SESSION_KEY) : Promise.resolve(undefined)]);
    let unlocked = status.unlocked;
    let signInRun = status.signInRun;
    let hasStored = typeof stored === "string" && stored.length > 0;
    let ended = false;
    const take = async (reply: RunReply) => {
      signInRun = reply.signInRun;
      if (reply.unlocked) unlocked = true;
      if (reply.persist && persists && touchID) {
        await ardia.secrets.set(STORED_SESSION_KEY, reply.persist);
        hasStored = true;
      }
    };
    const verb = async (verbId: string, params: VerbParams = {}, verbOptions: VerbOptions = {}): Promise<VerbResult> => {
      const request = { verb: verbId, params, ...(verbOptions.timeoutMs !== undefined ? { timeoutMs: verbOptions.timeoutMs } : {}) };
      let reply = replyOf(verbId, await sidecar(SIDECAR_METHODS.run, request));
      await take(reply);
      while (reply.running) {
        for (const text of reply.lines) verbOptions.onLine?.({ stream: "stdout", text });
        if (ended) return resultOf(reply);
        reply = replyOf(verbId, await sidecar(SIDECAR_METHODS.wait, { run: reply.running, waitMs: STREAM_WAIT_MS }));
        await take(reply);
      }
      const definition = Object.hasOwn(spec.verbs, verbId) ? spec.verbs[verbId] : undefined;
      if (verbOptions.onItem && definition) itemsOf(definition, reply.json)?.forEach((item, index) => verbOptions.onItem?.(item, index));
      return resultOf(reply);
    };
    const ctx: CredentialContext = {
      name,
      provider: id,
      touchID,
      offline,
      signal: call.signal,
      cli: {
        name: spec.name,
        get signInRun() {
          return signInRun;
        },
        verb,
        async cancelSigningIn() {
          signInRun = statusOf(await sidecar(SIDECAR_METHODS.cancelSignIn)).signInRun;
        },
      },
      session: {
        get current() {
          return unlocked ? { key: SESSION_HANDLE } : null;
        },
        get hasStored() {
          return hasStored;
        },
        async takeStored(): Promise<SecretHandle | null> {
          if (!hasStored) return null;
          const value = await ardia.secrets.get(STORED_SESSION_KEY);
          if (!value) {
            hasStored = false;
            return null;
          }
          await sidecar(SIDECAR_METHODS.offer, { value });
          return STORED_HANDLE;
        },
        async dropStored() {
          hasStored = false;
          if (persists) await ardia.secrets.delete(STORED_SESSION_KEY);
          unlocked = statusOf(await sidecar(SIDECAR_METHODS.drop)).unlocked;
        },
      },
      scratch,
      preferences,
      owner: {
        confirm: (reason) => ardia.ui.confirm({ title: `Allow ${info.title} to ${reason}?`, confirmTitle: "Allow" }),
      },
    };
    return { ctx, status, end: () => void (ended = true) };
  }

  function forgetOldListings() {
    const oldest = now() - CREDENTIAL_LIMITS.heldSnapshotMs;
    for (const [snapshot, listing] of held) if (listing.touched < oldest) held.delete(snapshot);
  }

  function pageFrom(snapshot: string, pages: ListedItem[][], index: number): ItemPage {
    const page: ItemPage = { snapshot, items: pages[index] ?? [] };
    if (index + 1 < pages.length) return { ...page, cursor: String(index + 1) };
    held.delete(snapshot);
    return page;
  }

  async function list(input: unknown, ctx: CredentialContext): Promise<unknown> {
    forgetOldListings();
    const asked: ListRequest = isRecord(input) ? { snapshot: typeof input.snapshot === "string" ? input.snapshot : null, cursor: typeof input.cursor === "string" ? input.cursor : null } : { snapshot: null, cursor: null };
    const kept = asked.snapshot ? held.get(asked.snapshot) : undefined;
    const index = asked.cursor !== null && /^[1-9][0-9]{0,8}$/.test(asked.cursor) ? Number(asked.cursor) : -1;
    if (kept && asked.snapshot && index > 0 && index < kept.pages.length) {
      kept.touched = now();
      return pageFrom(asked.snapshot, kept.pages, index);
    }
    const listed = await provider.list(kept || !asked.snapshot ? { snapshot: null, cursor: null } : asked, ctx);
    if (!Array.isArray(listed)) return listed;
    const pages = pageItems(listed as ListedItem[]);
    const snapshot = `s${(++snapshots).toString(36)}${Math.floor(now()).toString(36)}`;
    if (pages.length > 1) held.set(snapshot, { pages, touched: now() });
    return pageFrom(snapshot, pages, 0);
  }

  async function answer(name: CredentialHandlerName, input: unknown, call: CallContext): Promise<CredentialAnswer> {
    let end = () => {};
    if (!handlers.includes(name)) return { ok: false, error: CredentialError.unsupported().toWire() };
    try {
      const opened = await contextFor(name, call);
      end = opened.end;
      if (name === "state" && !opened.status.cli.found) return { ok: true, result: { state: "notInstalled", install: spec.install } };
      if (name === "list") return { ok: true, result: await list(input, opened.ctx) };
      const handler = handlerOf(provider, name);
      if (!handler) throw CredentialError.unsupported();
      const result = await handler((input ?? {}) as never, opened.ctx);
      if (name === "signOut") await opened.ctx.session.dropStored();
      if ((name === "signIn" || name === "unlock") && isRecord(result) && result.ok === true) {
        const { session, ...outcome } = result;
        await sidecar(isSecretHandle(session) && session.$secret === STORED_HANDLE.$secret ? SIDECAR_METHODS.adopt : SIDECAR_METHODS.open);
        return { ok: true, result: outcome };
      }
      return { ok: true, result: result === undefined ? null : result };
    } catch (error) {
      return { ok: false, error: wireErrorOf(error) };
    } finally {
      end();
    }
  }

  const description: ProviderDescription = {
    contract: CREDENTIALS_CONTRACT,
    provider: id,
    ...info,
    cli: { name: spec.name, install: spec.install, minimumVersion: spec.minimumVersion },
    handlers,
  };

  const service: ServiceHandlers = { describe: () => description };
  for (const name of CREDENTIAL_HANDLERS) service[serviceMethod(name)] = (input: unknown, call: CallContext) => answer(name, input, call);
  return { services: { [CREDENTIALS_SERVICE]: service } };
}
