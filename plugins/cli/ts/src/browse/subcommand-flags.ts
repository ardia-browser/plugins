export const SUBCOMMAND_FLAGS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  perf: {
    trace: ["--duration", "--reload", "--out"],
    insight: ["--duration", "--reload", "--crux", "--trace"],
  },
  logpoint: {
    add: ["--condition", "--column"],
    list: [],
    rm: [],
    clear: [],
    scripts: [],
  },
};

const ALWAYS = ["--help", "-h"];

export function subcommandFlagProblem(command: string, subcommand: string | undefined, words: readonly string[]): string | undefined {
  const table = SUBCOMMAND_FLAGS[command];
  if (table === undefined || subcommand === undefined || !Object.hasOwn(table, subcommand)) return undefined;
  const allowed = table[subcommand] as readonly string[];
  for (const word of words) {
    if (word === "--") break;
    if (!word.startsWith("--")) continue;
    const flag = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (ALWAYS.includes(flag) || allowed.includes(flag)) continue;
    const owner = Object.entries(table).find(([, flags]) => flags.includes(flag))?.[0];
    return `${command} ${subcommand} doesn't take ${flag}${owner === undefined ? "" : `; it goes with ${command} ${owner}`}`;
  }
  return undefined;
}
