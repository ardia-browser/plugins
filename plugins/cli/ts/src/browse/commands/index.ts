import { BrowseError, Usage } from "../daemon-errors.ts";
import { ALIASES, canonical, MUTATING, SKIPPED } from "../daemon/names.ts";
import { Result } from "../daemon/render.ts";
import { commandHelp } from "../help.ts";
import type { Ctx, Handler } from "./ctx.ts";
import { flag } from "../metrics.ts";
import { closest } from "../suggest.ts";

export { ALIASES, canonical, MUTATING, SKIPPED };


export const OWNERS: Readonly<Record<string, string>> = {
  open: "D3",
  back: "nav",
  forward: "nav",
  reload: "nav",
  pushstate: "nav",
  snapshot: "D4",
  notes: "D7",
  click: "D5",
  dblclick: "D5",
  hover: "D5",
  focus: "D5",
  fill: "D5",
  type: "D5",
  press: "D5",
  keydown: "D5",
  keyup: "D5",
  keyboard: "D5",
  check: "D5",
  uncheck: "D5",
  select: "D5",
  drag: "D5",
  upload: "D5",
  scroll: "D5",
  scrollintoview: "D5",
  mouse: "D5",
  wait: "D3",
  eval: "D7",
  get: "D4",
  is: "D4",
  find: "D4",
  tab: "tabs",
  window: "tabs",
  frame: "tabs",
  dialog: "tabs",
  storage: "D4",
  cookies: "D4",
  set: "D7",
  state: "D4",
  download: "D5",
  highlight: "D6",
  clipboard: "D7",
  addinitscript: "D7",
  removeinitscript: "D7",
  read: "D4",
  tools: "D4",
  tool: "D5",
  links: "D4",
  text: "D4",
  script: "D7",
  vitals: "D4",
  diff: "D4",
  session: "D3",
  batch: "D5",
  a11y: "D6",
  console: "D6",
  errors: "D6",
  network: "D6",
  trace: "D6",
  profiler: "D6",
  record: "D6",
  stream: "D6",
  flow: "D7",
  react: "D5",
  screenshot: "D6",
  pdf: "D6",
  auth: "D7",
  cdp: "D7",
  perf: "D8",
  styles: "D8",
  issues: "D8",
  logpoint: "D8",
  here: "tabs",
  form: "D4",
  query: "D4",
  "read-urls": "D4",
};

export type Step = unknown;

export type DispatchHooks = {
  before?: (ctx: Ctx, name: string, argv: string[]) => Promise<void>;
  begin?: (ctx: Ctx, name: string, argv: string[]) => Promise<Step>;
  end?: (ctx: Ctx, step: Step, error: BrowseError | null) => Promise<void>;
  abandon?: (ctx: Ctx, step: Step) => void;
  after?: (ctx: Ctx, name: string, argv: string[], result: Result) => void;
  afterCommand?: (state: Ctx["state"]) => Promise<void>;
  closeAfterBatch?: (state: Ctx["state"]) => boolean;
  shutdown?: () => Promise<void>;
};

const COMMANDS = new Map<string, Handler>();
export const hooks: DispatchHooks = {};

export function register(names: string | readonly string[], handler: Handler): void {
  for (const name of typeof names === "string" ? [names] : names) {
    if (!Object.hasOwn(OWNERS, name)) throw new Error(`register: ${name} isn't a command of ardia browse`);
    if (COMMANDS.has(name)) throw new Error(`register: ${name} is registered twice`);
    COMMANDS.set(name, handler);
  }
}

export function served(name: string): boolean {
  return COMMANDS.has(name);
}

export function handlerOf(name: string): Handler | undefined {
  return COMMANDS.get(name);
}

export function unknownCommand(name: string): Usage {
  const guess = closest(name, [...Object.keys(OWNERS), ...Object.keys(ALIASES)].filter((known) => !Object.hasOwn(SKIPPED, known)));
  if (guess === undefined) return new Usage(`Unknown command: ${name}. Run \`ardia browse --help\``);
  flag("did_you_mean", true);
  return new Usage(`Unknown command: ${name}. Did you mean \`ardia browse ${guess}\`? Run \`ardia browse --help\` for the rest`);
}

const HELP_WORDS = new Set(["--help", "-h"]);
export const TAKES_SUBCOMMAND: ReadonlySet<string> = new Set([
  "network", "tab", "window", "storage", "cookies", "state", "set", "dialog", "diff", "record", "stream", "trace", "profiler", "react", "plugin",
  "session", "notes", "flow", "auth", "perf", "logpoint", "keyboard", "mouse", "get", "is", "snapshot", "clipboard",
]);

export function asksHelp(name: string, argv: readonly string[]): boolean {
  if (argv.length > 0 && HELP_WORDS.has(argv[0] as string)) return true;
  return TAKES_SUBCOMMAND.has(name) && argv.length > 1 && HELP_WORDS.has(argv[1] as string) && !(argv[0] as string).startsWith("-");
}

export async function dispatch(ctx: Ctx, name: string, argv: string[]): Promise<Result> {
  if ((Object.hasOwn(OWNERS, name) || Object.hasOwn(SKIPPED, name)) && asksHelp(name, argv)) {
    flag("help_in_daemon", true);
    return new Result({ help: commandHelp(name) }, commandHelp(name));
  }
  if (name === "auth") {
    if (argv[0] !== "login") throw new Usage("auth save|list|show|delete run without the daemon");
    return (COMMANDS.get("auth") as Handler)(ctx, argv.slice(1));
  }
  if (Object.hasOwn(SKIPPED, name)) throw new BrowseError(`\`${name}\` isn't part of ardia browse: ${SKIPPED[name]}`, null, "unsupported");
  const handler = COMMANDS.get(name);
  if (handler === undefined) throw unknownCommand(name);
  if (ctx.state && name !== "batch" && (ctx.state.topCommand !== "script" || name === "script")) ctx.state.commandsRun += 1;
  if (ctx.state) ctx.state.leftOffscreen = null;
  if (name !== "batch" && hooks.before) await hooks.before(ctx, name, argv);
  const step = hooks.begin ? await hooks.begin(ctx, name, argv) : null;
  let result: Result;
  try {
    result = await handler(ctx, argv);
  } catch (error) {
    if (error instanceof BrowseError) {
      if (hooks.end) await hooks.end(ctx, step, error);
    } else {
      hooks.abandon?.(ctx, step);
    }
    throw error;
  }
  if (hooks.end) await hooks.end(ctx, step, null);
  if (name !== "batch" && ctx.state.topCommand !== "script") hooks.after?.(ctx, name, argv, result);
  return result;
}
