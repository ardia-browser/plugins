import { writeSync } from "node:fs";
import { catchInterrupts } from "./control.ts";
import { bundledPython, installRoot } from "./install.ts";
import { releaseLifeline, watchLifeline } from "./lifeline.ts";
import { abandonedOutput } from "./printable.ts";
import { HAND_BACK, takeMarker } from "./routed.ts";
import { servesNatively } from "./served.ts";
import { cliVersion } from "./version.ts";

const LOSSY = "\ufffd";
const ABANDONED_WRITE_GRACE_MS = 200;
const NOT_ROUTED = "ardia-ts: this program runs only as part of ardia; run ardia instead\n";

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

async function main(words: string[]): Promise<number> {
  const routed = takeMarker(words);
  if (routed === undefined) {
    try {
      writeSync(2, NOT_ROUTED);
    } catch {}
    return 2;
  }
  watchLifeline(routed.lifeline);
  if (!routed.interruptsIgnored) catchInterrupts();
  const argv = routed.argv;
  if (argv.some((word) => word.includes(LOSSY))) return HAND_BACK;
  if (asksForVersion(argv) && servesNatively("--version")) {
    try {
      writeSync(1, `ardia ${cliVersion()}\n`);
    } catch (error) {
      return (await import("./printable.ts")).stdoutFlushFailed(error);
    }
    return 0;
  }
  return (await serve(argv, bundledPython(installRoot()))) ?? HAND_BACK;
}

const status = await main(process.argv.slice(2));
releaseLifeline();
process.exitCode = status;
if (abandonedOutput()) setTimeout(() => process.exit(status), ABANDONED_WRITE_GRACE_MS).unref();
