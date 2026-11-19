import { writeSync } from "node:fs";
import { bundledPython, dropLease, handOff, installRoot, takeLease } from "./handoff.ts";
import { servesNatively } from "./served.ts";
import { cliVersion } from "./version.ts";

const LOSSY = "\ufffd";

function asksForVersion(argv: string[]): boolean {
  return argv.length === 1 && argv[0] === "--version";
}

async function serve(argv: string[], python: string | null): Promise<number | undefined> {
  const [{ route }, paths] = await Promise.all([import("./route.ts"), import("./paths.ts")]);
  const chosen = route(argv);
  if (chosen.kind === "python" || chosen.kind === "version") return undefined;
  const { consentUnreadable, dataDirArg, leadingTokens } = await import("./telemetry.ts");
  const named = [process.env.ARDIA_DATA_DIR, process.env.ARDIA_CLI_HOME, dataDirArg(leadingTokens(argv))];
  if (chosen.kind === "listing") named.push(chosen.listing.dataDir);
  if (!paths.pathsAreText() || named.some(paths.needsAccountLookup) || consentUnreadable(argv)) return undefined;
  const { serveHelp, serveListing } = await import("./serve.ts");
  try {
    if (chosen.kind === "help") return serveHelp(argv, python);
    return await serveListing(chosen.what, chosen.listing, argv, python);
  } catch (error) {
    if (error instanceof paths.NeedsPython) return undefined;
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  const root = installRoot();
  const python = bundledPython(root);
  const lease = takeLease(root);
  try {
    if (argv.some((word) => word.includes(LOSSY))) return await handOff(argv, python);
    if (asksForVersion(argv) && servesNatively("--version")) {
      try {
        writeSync(1, `ardia ${cliVersion()}\n`);
      } catch {}
      return 0;
    }
    return (await serve(argv, python)) ?? (await handOff(argv, python));
  } finally {
    dropLease(lease);
  }
}

process.exitCode = await main(process.argv.slice(2));
