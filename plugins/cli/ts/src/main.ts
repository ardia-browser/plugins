import { handOff } from "./handoff.ts";

declare const ARDIA_CLI_VERSION: string | undefined;

export const VERSION = typeof ARDIA_CLI_VERSION === "string" ? ARDIA_CLI_VERSION : "0.0.0.dev0";

function main(argv: string[]): number {
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`ardia ${VERSION}\n`);
    return 0;
  }
  return handOff(argv);
}

process.exitCode = main(process.argv.slice(2));
