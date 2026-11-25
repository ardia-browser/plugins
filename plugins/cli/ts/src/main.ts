import { read, write, writeSync } from "node:fs";
import { catchInterrupts } from "./control.ts";
import type { NotesArgv } from "./browse/route.ts";
import { interruptsIgnored, LIBC_UNAVAILABLE, LibcUnavailable, loadLibc, watchLifeline, writeWhole } from "./libc.ts";
import { FLUSH_ARGUMENT, HISTORY_ARGUMENT, SCRIPT_RUNNER_ARGUMENT } from "./flush-argument.ts";
import { bundledPython, installRoot } from "./install.ts";
import { abandonedOutput, settleStderr } from "./printable.ts";
import { HAND_BACK, takeMarker } from "./routed.ts";
import { servesNatively } from "./served.ts";
import { cliVersion } from "./version.ts";

const LOSSY = "\ufffd";
const ABANDONED_WRITE_GRACE_MS = 200;
const NOT_IN_THIS_BUILD = "ardia: this command still runs on Python, which this build of ardia doesn't include\n";

function notInThisBuild(): number {
  try {
    writeSync(2, NOT_IN_THIS_BUILD);
  } catch {}
  return 1;
}

function asksForVersion(argv: string[]): boolean {
  return argv.length === 1 && argv[0] === "--version";
}

let browseServed = false;

async function serveBrowse(argv: string[], python: string | null, notes?: NotesArgv): Promise<number | undefined> {
  const [browse, paths, { consentUnreadable }, { pluginMode }] = await Promise.all([
    import("./browse/index.ts"),
    import("./paths.ts"),
    import("./telemetry.ts"),
    import("./browse/route.ts"),
  ]);
  if (!paths.pathsAreText() || (!pluginMode() && consentUnreadable(argv))) return browse.refuseOrHandBack(argv, python);
  try {
    return await (notes === undefined ? browse.serveBrowse(argv, python) : browse.serveNotes(argv, notes, python));
  } catch (error) {
    if (error instanceof paths.NeedsPython) return browse.refuseOrHandBack(argv, python);
    throw error;
  }
}

async function serve(argv: string[], python: string | null): Promise<number | undefined> {
  const first = await serveOnce(argv, python);
  if (first !== undefined || browseServed) return first;
  const { canonicalArgv, frontEndOutcome } = await import("./argparse-cli.ts");
  const expanded = canonicalArgv(argv);
  if (expanded !== undefined) {
    (await import("./telemetry.ts")).recordFlagsAsTyped(argv);
    const again = await serveOnce(expanded, python);
    if (again !== undefined) return again;
  }
  const outcome = frontEndOutcome(argv);
  if (outcome.kind === "served") return (await import("./argparse-serve.ts")).serveArgparse(outcome.served, argv, python);
  return undefined;
}

async function serveOnce(argv: string[], python: string | null): Promise<number | undefined> {
  const { invokesBrowse, notesArgv, pluginMode } = await import("./browse/route.ts");
  if (pluginMode() || (invokesBrowse(argv) && servesNatively("browse"))) {
    browseServed = true;
    return serveBrowse(argv, python);
  }
  const notes = notesArgv(argv);
  if (notes !== undefined && servesNatively("notes")) {
    browseServed = true;
    return serveBrowse(argv, python, notes);
  }
  const [{ route, withArgparse }, paths, { parseCommand }] = await Promise.all([import("./route.ts"), import("./paths.ts"), import("./commands.ts")]);
  const chosen = await withArgparse(route(argv, undefined, parseCommand), argv);
  if (chosen.kind === "python" || chosen.kind === "version") return undefined;
  const { consentUnreadable } = await import("./telemetry.ts");
  if (!paths.pathsAreText() || consentUnreadable(argv)) return undefined;
  try {
    if (chosen.kind === "computer" || chosen.kind === "hooks" || chosen.kind === "on") return await (await import("./serve-commands.ts")).serveCommand(chosen, argv, python);
    const { serveHelp, serveListing } = await import("./serve.ts");
    if (chosen.kind === "help") return serveHelp(argv, python);
    if (chosen.kind === "command") return await (await import("./runner.ts")).runCommand(chosen.route.command, argv, python);
    if (chosen.kind === "config") return await (await import("./config-commands.ts")).serve(chosen.command, python);
    if (chosen.kind === "scripts") return await (await import("./scripts/serve.ts")).serveScripts(chosen.args, argv, python);
    if (chosen.kind === "tools") return await (await import("./serve-command.ts")).serveCommand(chosen.command, argv, python);
    if (chosen.kind === "argparse") return (await import("./argparse-serve.ts")).serveArgparse(chosen.served, argv, python);
    return await serveListing(chosen.what, chosen.listing, argv, python);
  } catch (error) {
    if (error instanceof paths.NeedsPython) return undefined;
    throw error;
  }
}

async function addonFailure(error: LibcUnavailable, argv: string[]): Promise<{ fd: number; text: string }> {
  const [{ invokesBrowse }, { jsonIntentOfArgv }] = await Promise.all([import("./browse/route.ts"), import("./browse/args.ts")]);
  if (!invokesBrowse(argv) || !jsonIntentOfArgv(argv)) return { fd: 2, text: `${error.message}\n` };
  return { fd: 1, text: `${JSON.stringify({ success: false, data: null, error: error.message, code: "internal_error" })}\n` };
}

function failWithoutAddon(failure: { fd: number; text: string }, lifeline: number): Promise<number> {
  const sink = Buffer.alloc(64);
  const watch = () =>
    read(lifeline, sink, 0, sink.length, null, (error, count) => {
      if (error === null && count > 0) watch();
      else if (error?.code !== "EAGAIN" && error?.code !== "EINTR") process.kill(process.pid, "SIGKILL");
      else setTimeout(watch, 50);
    });
  watch();
  return new Promise((resolve) => write(failure.fd, failure.text, () => resolve(LIBC_UNAVAILABLE)));
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
  if (words[0] === "daemon") process.exit(await (await import("./browse/daemon/main.ts")).daemonMain(words.slice(1)));
  if (words.length === 1 && words[0] === FLUSH_ARGUMENT) return runFlusher();
  if (words.length === 1 && words[0] === HISTORY_ARGUMENT) return (await import("./browsing.ts")).historyChild();
  if (words.length === 2 && words[0] === SCRIPT_RUNNER_ARGUMENT) return (await import("./browse/script/runner.ts")).runnerMain(words[1] as string);
  const routed = takeMarker(words);
  const argv = routed?.argv ?? words;
  try {
    loadLibc();
  } catch (error) {
    if (!(error instanceof LibcUnavailable)) throw error;
    const failure = await addonFailure(error, argv);
    if (routed === undefined) {
      try {
        writeSync(failure.fd, failure.text);
      } catch {}
      return LIBC_UNAVAILABLE;
    }
    process.exit(await failWithoutAddon(failure, routed.lifeline));
  }
  if (routed !== undefined) watchLifeline(routed.lifeline);
  if (argv.includes("mcp")) {
    const mcp = await import("./mcp/index.ts");
    const managed = mcp.mcpManageArgv(argv);
    if (managed !== undefined) process.exit(mcp.mcpManageMain(managed));
    const parsed = mcp.mcpArgv(argv);
    if (parsed !== undefined) process.exit(await mcp.mcpMain(parsed));
  }
  if (!interruptsIgnored()) catchInterrupts();
  const handBack = routed === undefined ? notInThisBuild : () => HAND_BACK;
  if (argv.some((word) => word.includes(LOSSY))) {
    const recovered = (await import("./argv-bytes.ts")).rawArguments(argv.length);
    if (recovered === undefined) return handBack();
    argv.splice(0, argv.length, ...recovered);
  }
  if (!process.env.ARDIA_BROWSE_FOR_PLUGIN) {
    const placed = (await import("./endpoint-flags.ts")).placeEndpointFlags(argv);
    if (placed.dropped.includes("--port")) (await import("./telemetry.ts")).noteDroppedEndpoint();
    argv.splice(0, argv.length, ...placed.argv);
  }
  if (asksForVersion(argv) && servesNatively("--version") && !process.env.ARDIA_BROWSE_FOR_PLUGIN) {
    try {
      writeWhole(1, Buffer.from(`ardia ${cliVersion()}\n`));
    } catch (error) {
      return (await import("./printable.ts")).versionWriteFailed(error);
    }
    return 0;
  }
  return (await serve(argv, bundledPython(installRoot()))) ?? handBack();
}

const status = settleStderr(await main(process.argv.slice(2)));
process.exitCode = status;
if (abandonedOutput()) setTimeout(() => process.exit(status), ABANDONED_WRITE_GRACE_MS).unref();
else if (browseServed) process.exit(status);
