import specsText from "./argparse-specs.json" with { type: "text" };
import { type Environment, errorWith, type Exit, helpWith, type Parsed, parseWith, type ParserSpec, terminalColumns } from "./argparse.ts";
import { installedDataDir } from "./control.ts";
import { expandUser, join, LINUX, purePath } from "./paths.ts";
import { cliVersion } from "./version.ts";

export type Constants = {
  max_timeout: string;
  max_timeout_shown: string;
  shared_value_flags: string[];
  shared_bool_flags: string[];
  removed_commands: Record<string, string>;
  computer_labels: Record<string, string>;
};

type Specs = {
  config_folder: string;
  version: string;
  constants: Constants;
  parsers: Record<string, Record<string, ParserSpec>>;
};

export const ROOT = "ardia";

let loaded: Specs | undefined;

function specs(text: string = specsText): Specs {
  loaded ??= JSON.parse(text) as Specs;
  return loaded;
}

export function defaultConfigFolder(linux: boolean = LINUX): string {
  return linux ? join(installedDataDir(true), "config") : purePath(join(expandUser("~"), ".config", "ardia"));
}

export type Overrides = { linux?: boolean; columns?: number; version?: string; configFolder?: string };

export function environment(overrides: Overrides = {}): Environment {
  const all = specs();
  const linux = overrides.linux ?? LINUX;
  const platform = all.parsers[linux ? "linux" : "macos"] ?? {};
  const common = all.parsers.common ?? {};
  let folder: string | undefined;
  let columns: number | undefined;
  return {
    parser(prog: string): ParserSpec {
      const found = platform[prog] ?? common[prog];
      if (found === undefined) throw new Error(`no argparse spec for ${prog}`);
      return found;
    },
    columns(): number {
      columns ??= overrides.columns ?? terminalColumns();
      return columns;
    },
    text(text: string): string {
      let shown = text;
      if (shown.includes(all.version)) shown = shown.replaceAll(all.version, overrides.version ?? cliVersion());
      if (shown.includes(all.config_folder)) {
        folder ??= overrides.configFolder ?? defaultConfigFolder(linux);
        shown = shown.replaceAll(all.config_folder, folder);
      }
      return shown;
    },
    maxTimeout: Number(all.constants.max_timeout),
    maxTimeoutShown: all.constants.max_timeout_shown,
  };
}

export function constants(): Constants {
  return specs().constants;
}

export function knownParsers(linux: boolean = LINUX): string[] {
  const all = specs();
  return [...new Set([...Object.keys(all.parsers.common ?? {}), ...Object.keys(all.parsers[linux ? "linux" : "macos"] ?? {})])].sort();
}

export function parseArgs(specName: string, argv: readonly string[], overrides: Overrides = {}): Parsed {
  return parseWith(environment(overrides), specName, argv);
}

export function helpFor(specName: string, overrides: Overrides = {}): string {
  return helpWith(environment(overrides), specName);
}

export function usageError(specName: string, message: string, overrides: Overrides = {}): Exit {
  return errorWith(environment(overrides), specName, message);
}
