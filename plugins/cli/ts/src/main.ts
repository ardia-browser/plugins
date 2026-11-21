import { read, write, writeSync } from "node:fs";
import { catchInterrupts } from "./control.ts";
import { interruptsIgnored, LIBC_UNAVAILABLE, LibcUnavailable, loadLibc, watchLifeline, writeWhole } from "./libc.ts";
import { FLUSH_ARGUMENT } from "./flush-argument.ts";
import { bundledPython, installRoot } from "./install.ts";
import { abandonedOutput, settleStderr } from "./printable.ts";
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

function failWithoutAddon(message: string, lifeline: number): Promise<number> {
  const sink = Buffer.alloc(64);
  const watch = () =>
    read(lifeline, sink, 0, sink.length, null, (error, count) => {
      if (error === null && count > 0) watch();
      else if (error?.code !== "EAGAIN" && error?.code !== "EINTR") process.kill(process.pid, "SIGKILL");
      else setTimeout(watch, 50);
    });
  watch();
  return new Promise((resolve) => write(2, message, () => resolve(LIBC_UNAVAILABLE)));
}

async function runFlusher(): Promise<number> {
  try {
    loadLibc();
  } catch {
    return 0;
  }
  const { FLUSH_DEADLINE_MS, flushMain } = await import("./flush.ts");
  setTimeout(() => process.exit(0), FLUSH_DEADLINE_MS).unref();
  await flushMain();
  process.exit(0);
}

async function main(words: string[]): Promise<number> {
  if (words.length === 1 && words[0] === FLUSH_ARGUMENT) return runFlusher();
  const routed = takeMarker(words);
  if (routed === undefined) {
    try {
      writeSync(2, NOT_ROUTED);
    } catch {}
    return 2;
  }
  try {
    loadLibc();
  } catch (error) {
    if (!(error instanceof LibcUnavailable)) throw error;
    process.exit(await failWithoutAddon(`${error.message}\n`, routed.lifeline));
  }
  watchLifeline(routed.lifeline);
  if (!interruptsIgnored()) catchInterrupts();
  const argv = routed.argv;
  if (argv.some((word) => word.includes(LOSSY))) return HAND_BACK;
  if (asksForVersion(argv) && servesNatively("--version")) {
    try {
      writeWhole(1, Buffer.from(`ardia ${cliVersion()}\n`));
    } catch (error) {
      return (await import("./printable.ts")).versionWriteFailed(error);
    }
    return 0;
  }
  return (await serve(argv, bundledPython(installRoot()))) ?? HAND_BACK;
}

const status = settleStderr(await main(process.argv.slice(2)));
process.exitCode = status;
if (abandonedOutput()) setTimeout(() => process.exit(status), ABANDONED_WRITE_GRACE_MS).unref();
