import { join } from "../paths.ts";
import { LINUX, NeedsPython } from "../paths.ts";
import { floatValue, type OptionSpec, parseOptions } from "../argparse.ts";
import type { CommandIo } from "../cmdio.ts";
import type { CommandRoute } from "../serve-commands.ts";
import type { Call } from "../telemetry.ts";
import { configFolder } from "../configfiles.ts";
import * as texts from "./texts.ts";
import { HOOKS_FILE } from "./model.ts";
import { arrange, type Verb } from "./route.ts";

const TOP_FLAGS = ["-h", "--help", "--version", "--skill"];

const DATA_DIR: OptionSpec = { long: "--data-dir", kind: "value" };
const HELP: OptionSpec = { long: "--help", short: "-h", kind: "help" };
const VERB_OPTIONS: Record<Verb, OptionSpec[]> = {
  list: [HELP, DATA_DIR, { long: "--json", kind: "flag" }],
  install: [HELP, DATA_DIR],
  uninstall: [HELP, DATA_DIR],
  run: [HELP, DATA_DIR, { long: "--log", kind: "value" }],
};
const VERB_TEXTS: Record<Verb, [string, string]> = {
  list: [texts.LIST_USAGE, LINUX ? texts.LINUX_LIST_HELP : texts.LIST_HELP],
  install: [texts.INSTALL_USAGE, LINUX ? texts.LINUX_INSTALL_HELP : texts.INSTALL_HELP],
  uninstall: [texts.UNINSTALL_USAGE, LINUX ? texts.LINUX_UNINSTALL_HELP : texts.UNINSTALL_HELP],
  run: [texts.RUN_USAGE, LINUX ? texts.LINUX_RUN_HELP : texts.RUN_HELP],
};
const ON_OPTIONS: OptionSpec[] = [
  HELP,
  DATA_DIR,
  { long: "--match", kind: "value", repeat: true },
  { long: "--timeout", kind: "value", float: true },
  { long: "--idle", kind: "value" },
  { long: "--full-urls", kind: "flag" },
];

function flagNames(flags: readonly string[]): string[] {
  return flags.filter((token) => token.startsWith("--")).map((token) => token.split("=", 1)[0] as string);
}

export type Settle = (run: () => Promise<number>) => Promise<number | undefined>;

export async function serveHooks(route: CommandRoute, argv: string[], call: Call, io: CommandIo, _python: string | null, settle: Settle): Promise<number | undefined> {
  const arranged = arrange(argv);
  if (arranged === undefined) return undefined;
  const { path, hoisted, rest } = arranged;
  const verb = path[1] as Verb | undefined;
  const isOn = path[0] === "on";
  if (!isOn && verb === undefined) return undefined;
  const options = isOn ? ON_OPTIONS : VERB_OPTIONS[verb as Verb];
  call.command = path[0] as string;
  call.subcommand = isOn ? undefined : verb;
  call.allowedFlags = [...TOP_FLAGS, ...(isOn ? [] : ["-h", "--help"]), ...options.flatMap((option) => (option.short === undefined ? [option.long] : [option.short, option.long]))];
  void route;
  return settle(async () => {
    const leafNames = new Set(options.flatMap((option) => (option.short === undefined ? [option.long] : [option.short, option.long])));
    for (const name of flagNames(hoisted)) {
      if (!leafNames.has(name)) {
        io.err(`ardia: ${path.join(" ")} doesn't take ${name}`);
        return 2;
      }
    }
    let leaf = [...hoisted, ...rest];
    let program: string[] | undefined;
    if (isOn) {
      const whole = [...path, ...leaf];
      const cut = whole.indexOf("--");
      if (cut >= 0) {
        program = whole.slice(cut + 1);
        leaf = whole.slice(1, cut);
      }
    }
    const [usage, help] = isOn ? [texts.ON_USAGE, texts.ON_HELP] : VERB_TEXTS[verb as Verb];
    const prog = `ardia ${path.join(" ")}`;
    const parsed = parseOptions(leaf, options, prog, usage, help, { extrasUsage: texts.TOP_USAGE, extrasProg: "ardia", ...(isOn ? { positionals: ["EVENT[,EVENT...]"], explicitUsage: true } : {}) });
    if (parsed.kind === "exit") return io.exitWith(parsed);
    const dataDir = parsed.values.get("--data-dir");
    const commands = await import("./commands.ts");
    if (isOn) {
      const timeout = parsed.values.has("--timeout") ? floatValue(parsed.values.get("--timeout") as string) : 60;
      return commands.cmdOn(io, { dataDir, events: parsed.positionals[0] as string, match: parsed.repeated.get("--match") ?? [], timeout, idle: parsed.values.get("--idle"), fullUrls: parsed.flags.has("--full-urls"), program });
    }
    if (verb === "list") return commands.hooksList(io, dataDir, parsed.flags.has("--json"));
    if (verb === "install") return commands.hooksInstall(io, dataDir);
    if (verb === "uninstall") return commands.hooksUninstall(io, dataDir);
    return commands.hooksRun(io, dataDir, parsed.values.get("--log"));
  });
}

export function hooksFile(dataDir: string | undefined): string {
  return join(configFolder(dataDir), HOOKS_FILE);
}

export { NeedsPython };
