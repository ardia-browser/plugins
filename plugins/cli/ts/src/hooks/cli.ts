import { join } from "../paths.ts";
import { LINUX, NeedsPython } from "../paths.ts";
import type { ArgValue } from "../argparse.ts";
import { environment, parseArgs } from "../argparse-env.ts";
import type { CommandIo } from "../cmdio.ts";
import type { CommandRoute } from "../serve-commands.ts";
import type { Call } from "../telemetry.ts";
import { configFolder } from "../configfiles.ts";
import { HOOKS_FILE } from "./model.ts";
import { arrange, type Verb } from "./route.ts";

const TOP_FLAGS = ["-h", "--help", "--version", "--skill"];

function specOf(isOn: boolean, verb: Verb | undefined): string {
  return isOn ? "ardia on" : `ardia hooks ${verb}`;
}

function optionStrings(spec: string): string[] {
  return environment().parser(spec).actions.flatMap((action) => action.option_strings);
}

function text(value: ArgValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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
  const spec = specOf(isOn, verb);
  const options = optionStrings(spec);
  call.command = path[0] as string;
  call.subcommand = isOn ? undefined : verb;
  call.allowedFlags = [...TOP_FLAGS, ...(isOn ? [] : ["-h", "--help"]), ...options];
  void route;
  return settle(async () => {
    const leafNames = new Set(options);
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
    const parsed = parseArgs("ardia", [...path, ...leaf]);
    if (!parsed.ok) return io.exitWith(parsed);
    if (parsed.stderr) io.exitWith({ status: 0, stdout: "", stderr: parsed.stderr });
    const values = parsed.values;
    const dataDir = text(values.get("data_dir"));
    const commands = await import("./commands.ts");
    if (isOn) {
      const match = values.get("match");
      return commands.cmdOn(io, {
        dataDir,
        events: text(values.get("events")) as string,
        match: Array.isArray(match) ? match.filter((item): item is string => typeof item === "string") : [],
        timeout: Number(values.get("timeout")),
        idle: text(values.get("idle")),
        fullUrls: values.get("full_urls") === true,
        program,
      });
    }
    if (verb === "list") return commands.hooksList(io, dataDir, values.get("json") === true);
    if (verb === "install") return commands.hooksInstall(io, dataDir);
    if (verb === "uninstall") return commands.hooksUninstall(io, dataDir);
    return commands.hooksRun(io, dataDir, text(values.get("log")));
  });
}

export function hooksFile(dataDir: string | undefined): string {
  return join(configFolder(dataDir), HOOKS_FILE);
}

export { NeedsPython };
