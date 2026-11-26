export type Awaitable<T> = T | Promise<T>;

export type DeniedCommand = { argv: readonly string[]; withFlags?: readonly string[] };
export type DeniedMatch = { argv: readonly string[]; flag?: string; why: string };

export type CredentialHandlerName =
  | "state"
  | "signIn"
  | "unlock"
  | "signOut"
  | "configure"
  | "list"
  | "reveal"
  | "save"
  | "edit"
  | "addTotp"
  | "passkeys.list"
  | "passkeys.get"
  | "passkeys.save"
  | "link";

export type CredentialPasskeyVia = "system" | "extension";

export type CredentialCapability = "totp" | "save" | "edit" | "addTotp" | "passkeys" | "selfHosted" | "masterPassword" | "touchID";

export type SecretHandle = { readonly $secret: string };

export type ProviderStateName = "signedOut" | "locked" | "unlocked" | "unavailable";
export type HostProviderStateName = ProviderStateName | "notInstalled";
export type FailureState = "signedOut" | "locked" | "unavailable";

export type ServerRef = { readonly preset: string } | { readonly url: string };

export type ProviderState = { state: ProviderStateName; account?: string; server?: ServerRef; detail?: string; problem?: ProblemCode };

export type HostProviderState = ProviderState | { state: "notInstalled"; install: CliInstall };

export type UrlMatch = "" | "host" | "exact";

export type ItemPasskey = { credentialId: string; rpId: string; userName: string; displayName: string; discoverable: boolean; counter: number };

export type Item = {
  id: string;
  title: string;
  username: string;
  urls: string[];
  urlMatch?: UrlMatch[];
  hasTotp?: boolean;
  totpPeriod?: number;
  vault?: string;
  favorite?: boolean;
  updatedAt?: number;
  passkeys?: ItemPasskey[];
};

export type ItemSecrets = { password?: string; totp?: string };

export type ListedItem = Item & { secrets?: ItemSecrets };

export type ListRequest = { snapshot: string | null; cursor: string | null };

export type ItemPage = { snapshot: string; items: readonly ListedItem[]; cursor?: string };

export type RevealField = "username" | "password" | "totp";

export type RevealRequest = { id: string; fields: readonly RevealField[] };

export type LinkRequest = { id: string };

export type ItemLink = { url: string };

export type RevealedTotp = { uri: string } | { code: string; period?: number };

export type Revealed = { username?: string; password?: string; totp?: RevealedTotp };

export type NewLogin = { title: string; username: string; password: string; url: string };

export type SaveRequest = { login: NewLogin };

export type TotpChange = { set: string } | "remove";

export type LoginChange = { username?: string; password?: string; url?: string; totp?: TotpChange };

export type EditRequest = { id: string; change: LoginChange };

export type AddTotpRequest = { id: string; uri: string };

export type StateRequest = { explicit: boolean };

export type SignInStep = "start" | "code" | "account";

export type SignInRequest = {
  method: string;
  step: SignInStep;
  fields: Readonly<Record<string, string>>;
  server?: ServerRef;
  code?: string;
  codeMethod?: string;
  account?: string;
};

export type UnlockRequest = { password: string | null };

export type ConfigureRequest = { server: ServerRef | null };

export type Choice = { id: string; title: string };

export type CodeMethod = Choice & { sendsCode?: boolean };

export type SignInNeed =
  | { kind: "code"; methods?: readonly CodeMethod[]; method?: string }
  | { kind: "field"; field: string }
  | { kind: "approval"; url: string }
  | { kind: "account"; choices: readonly Choice[] };

export type ProblemCode =
  | "wrongPassword"
  | "wrongCredentials"
  | "wrongCode"
  | "badCode"
  | "badServer"
  | "chooseMethod"
  | "codeOrNewDevice"
  | "needsApiKey"
  | "organizationKey"
  | "notAccepted"
  | "unlockNext"
  | "signOutFirst"
  | "signInFirst"
  | "lockedSinceLastUnlock"
  | "stayedLocked"
  | "approvalTimedOut"
  | "appUnreachable"
  | "setupNeeded"
  | "sessionLock"
  | "extraPassword"
  | "finishInBrowser"
  | "didntStart"
  | "premiumNeeded"
  | "noVault"
  | "unknownVault"
  | "cantPrepare"
  | "savedNotReturned"
  | "incomplete"
  | "notTaken"
  | "unreadable"
  | "tooSlow"
  | "notLaunched"
  | "timedOut"
  | "overflowed"
  | "offline"
  | "unreachable"
  | "outdated"
  | "cancelled"
  | "failed";

export type SignInOutcome =
  | { ok: true; session?: SecretHandle }
  | { ok: false; need: SignInNeed; problem?: ProblemCode; detail?: string; state?: FailureState }
  | { ok: false; need?: undefined; problem: ProblemCode; detail?: string; state?: FailureState; field?: string };

export type PasskeyListRequest = { rpId: string | null };

export type ListedPasskey = ItemPasskey & { item: string };

export type PasskeyGetRequest = { item: string; credentialId: string; rpId: string };

export type PrivateKeyMaterial = { format: "pkcs8"; der: string };

export type PasskeyKey = { credentialId: string; rpId: string; privateKey: PrivateKeyMaterial; userHandle: string; counter: number };

export type NewPasskey = {
  credentialId: string;
  credentialUuid: string;
  privateKey: PrivateKeyMaterial;
  publicKey: string;
  rpId: string;
  rpName: string;
  userHandle: string;
  userName: string;
  displayName: string;
  createdAt: number;
};

export type PasskeySaveRequest = { credential: NewPasskey; attachTo: string | null; title: string; url: string };

export type PasskeySaved = { item: string };

export type CredentialErrorCode = "locked" | "signedOut" | "notFound" | "unsupported" | "failed";

export type WireCredentialError = { code: CredentialErrorCode; problem?: ProblemCode; detail?: string; state?: FailureState; field?: string };

export type CredentialAnswer<T = unknown> = { ok: true; result: T } | { ok: false; error: WireCredentialError };

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type VerbParam = string | boolean | SecretHandle | JsonValue;

export type VerbParams = Readonly<Record<string, VerbParam | undefined>>;

export type StreamLine = { stream: "stdout" | "stderr"; text: string };

export type VerbOptions = {
  timeoutMs?: number;
  onItem?(item: unknown, index: number): void;
  onLine?(line: StreamLine): void;
};

export type VerbResult = {
  readonly verb: string;
  readonly status: number;
  readonly launched: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly overflowed: boolean;
  readonly succeeded: boolean;
  readonly stderr: string;
  readonly hints: readonly string[];
  readonly json: unknown;
  readonly lines: readonly string[];
  readonly items: number;
  readonly droppedLines: number;
  readonly unlocked: boolean;
};

export type SignInRunState = { state: "none" | "running" | "succeeded" | "failed"; hints: readonly string[]; detail?: string; timedOut?: boolean };

export type Cli = {
  readonly name: string;
  readonly signInRun: SignInRunState;
  verb(id: string, params?: VerbParams, options?: VerbOptions): Promise<VerbResult>;
  cancelSigningIn(): Promise<void>;
};

export type SessionStore = {
  readonly current: { readonly key: SecretHandle | null } | null;
  readonly hasStored: boolean;
  takeStored(reason: string): Promise<SecretHandle | null>;
  dropStored(): Promise<void>;
};

export type ValueStore = {
  get(key: string): string | undefined;
  set(key: string, value: string | null): Promise<void>;
};

export type Owner = { confirm(reason: string): Promise<boolean> };

export type CancelSignal = {
  readonly cancelled: boolean;
  onCancel(listener: () => void): { dispose(): void };
};

export type CredentialContext = {
  readonly name: CredentialHandlerName;
  readonly provider: string;
  readonly touchID: boolean;
  readonly offline: boolean;
  readonly signal: CancelSignal;
  readonly cli: Cli;
  readonly session: SessionStore;
  readonly scratch: ValueStore;
  readonly preferences: ValueStore;
  readonly owner: Owner;
};

export type CredentialHandler<I, O> = (input: I, ctx: CredentialContext) => Awaitable<O>;

export type PasskeyHandlers = {
  list?: CredentialHandler<PasskeyListRequest, readonly ListedPasskey[]>;
  get: CredentialHandler<PasskeyGetRequest, PasskeyKey | null>;
  save: CredentialHandler<PasskeySaveRequest, PasskeySaved>;
};

export type CredentialProvider = {
  state: CredentialHandler<StateRequest, ProviderState>;
  signIn: CredentialHandler<SignInRequest, SignInOutcome>;
  unlock: CredentialHandler<UnlockRequest, SignInOutcome>;
  signOut: CredentialHandler<Record<string, never>, void>;
  configure?: CredentialHandler<ConfigureRequest, void>;
  list: CredentialHandler<ListRequest, ItemPage | readonly ListedItem[]>;
  reveal: CredentialHandler<RevealRequest, Revealed>;
  save?: CredentialHandler<SaveRequest, Item>;
  edit?: CredentialHandler<EditRequest, Item>;
  addTotp?: CredentialHandler<AddTotpRequest, Item>;
  passkeys?: PasskeyHandlers;
  link?: CredentialHandler<LinkRequest, ItemLink>;
};

export type RunHints = { locked?: readonly string[]; signedOut?: readonly string[]; notFound?: readonly string[] };

export type JsonRecord = Record<string, unknown>;

export type TotpSecret = { secret: Uint8Array; period: number; digits: number; algorithm: "SHA1" | "SHA256" | "SHA512" };

export type SlotType = "id" | "enum" | "flag" | "url" | "email" | "code" | "secret" | "json";

export type VerbSlot = { type: SlotType; optional: boolean; pattern?: string; values?: readonly string[]; allowLocalHttp?: boolean };

export type ArgvToken = string | { slot: string } | { flag: string; slot: string } | { flag: string; when: string };

export type EnvEntry = { name: string; literal: string } | { name: string; secretSlot: string };

export type OutputMode = "json" | "lines" | "lastLineSecret" | "stream";

export type VerbOutput = { mode: OutputMode; items?: string };

export type VerbUnlocks = false | true | { persistent: boolean };

export type CredentialVerb = {
  argv: readonly ArgvToken[];
  slots: Readonly<Record<string, VerbSlot>>;
  env: readonly EnvEntry[];
  stdin: { slot: string; encoding: "utf8" | "base64" } | null;
  timeoutMs: number;
  outputLimitBytes: number;
  output: VerbOutput;
  signIn: boolean;
  unlocks: VerbUnlocks;
  outlivesCall: boolean;
  hints: Readonly<Record<string, readonly string[]>>;
};

export type CliInstall = { command: string; update?: string; url?: string };

export type CliSpec = {
  name: string;
  install: CliInstall;
  minimumVersion: string | null;
  sessionLastsSeconds: number | null;
  patterns: Readonly<Record<string, string>>;
  env: readonly EnvEntry[];
  verbs: Readonly<Record<string, CredentialVerb>>;
};

export type SignInFieldType = "text" | "email" | "secret";

export type SignInField = { id: string; title: string; type: SignInFieldType; placeholder?: string; hint?: string; optional?: boolean; prefill?: "account"; masked?: boolean };

export type SignInMethodKind = "fields" | "desktopApproval" | "browserApproval";

export type SignInMethod = { id: string; title: string; kind: SignInMethodKind; fields?: readonly SignInField[]; twoStep?: boolean; appURL?: string; appTitle?: string };

export type SignInServer = { id: string; title: string; custom?: { title: string; placeholder?: string } };

export type ProviderInfo = {
  title: string;
  symbol: string;
  accent?: string;
  readsOffline: boolean;
  approvalLastsSeconds?: number;
  capabilities: readonly CredentialCapability[];
  passkeys?: readonly ({ via: "system" } | { via: "extension"; extensions: readonly string[] })[];
  appLinks?: readonly string[];
  signIn: { methods: readonly SignInMethod[]; servers?: readonly SignInServer[]; unlock?: { field: string }; approvalHosts?: readonly string[] };
};

export type ProviderDescription = ProviderInfo & { contract: number; provider: string; cli: { name: string; install: CliInstall; minimumVersion: string | null }; handlers: readonly CredentialHandlerName[] };

export type Launch = { verb: string; program: string; argv: readonly string[]; env: Readonly<Record<string, string>>; stdin: string; timeoutMs: number; outputLimitBytes: number; signIn: boolean };

export type LaunchOutcome = { launched: boolean; status: number; stdout: string; stderr: string; timedOut: boolean; overflowed: boolean; cancelled: boolean };

export type LaunchIo = { onLine(line: StreamLine): void; cancelled: Promise<void> };

export type Launcher = (launch: Launch, io: LaunchIo) => Promise<LaunchOutcome>;

export type RunReply = VerbResult & { running?: string; persist?: string; signInRun: SignInRunState };

export type StatusReply = { unlocked: boolean; signInRun: SignInRunState; cli: { name: string; found: boolean } };
