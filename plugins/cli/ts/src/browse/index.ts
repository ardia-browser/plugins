import { NeedsPython } from "../paths.ts";
import { abandonWork, toStderr } from "../printable.ts";
import { Call, finish } from "../telemetry.ts";
import { cliVersion } from "../version.ts";
import { cleanMetrics, exitOf, outputChars, processStatus, textOf } from "./answer.ts";
import { allowedFlags, commandName, hoist, hoistFailure, jsonIntent, jsonIntentOfArgv, plainJsonIntent, refusalJsonIntent, splitGlobals, truthy, Usage } from "./args.ts";
import { codeJsonAnswer } from "./answer-codes.ts";
import { BrowseError, PythonCrash } from "./errors.ts";
import { Interrupted } from "./exchange.ts";
import { Printer } from "./output.ts";
import { checkRequest, CODE, dropCredential, message, pluginMode, PluginRefusal, REFUSED, takeAccess, UNAVAILABLE, UNAVAILABLE_WHY } from "./plugin.ts";
import { dumps, object, type Value } from "../json.ts";
import { Secrets } from "../redact.ts";
import { renderError } from "./render.ts";
import { environmentIsText, Refused, Unported } from "./request.ts";
import { HandBack, roundTrip } from "./serve.ts";
import { saveAnswer } from "./save-answer.ts";
import { AS_TEXT, takeOut } from "./outfile.ts";
import { Usage as DaemonUsage } from "./daemon-errors.ts";
import { NoDaemon } from "./session.ts";
import { pythonStdioErrors } from "./stdio.ts";

const HELP_WORDS = ["help", "--help", "-h"];
const CLOSED = 141;
const INTERRUPTED = 130;
const RESERVED_STATUS = 253;
const INTERNAL_ERROR = "internal_error";

type Outcome = { status: number | bigint; crash?: PythonCrash | undefined };

function handBackReason(error: unknown): string | undefined {
  if (error instanceof HandBack || error instanceof NoDaemon || error instanceof NeedsPython || error instanceof Unported) return error.message;
  return undefined;
}

function printError(error: BrowseError, asJson: boolean, secrets: Secrets, printer: Printer, call: Call): number {
  call.noteErrorCode(error.code);
  const { out, err } = renderError(error, asJson, secrets);
  printer.out(out);
  printer.err(err);
  return error.exit;
}

export function sayInterrupted(printer: Printer, asJson: boolean): void {
  if (asJson) printer.out(renderError(new BrowseError("interrupted", INTERRUPTED, "interrupted"), true, new Secrets()).out);
  else printer.err("✗ interrupted\n");
}

function sayCrash(printer: Printer, crash: PythonCrash, asJson: boolean): number {
  if (!asJson || printer.stopped) return printer.sayCrash(crash);
  printer.out(renderError(new BrowseError(crash.line, 1, INTERNAL_ERROR), true, new Secrets()).out);
  return printer.stopped ? printer.sayCrash(crash) : 1;
}

function invalidReply(answer: Map<string, Value>, secrets: Secrets): PythonCrash | undefined {
  for (const key of ["out", "err"]) {
    const text = textOf(answer.get(key), secrets.known());
    if (text instanceof PythonCrash) return text;
  }
  const status = exitOf(answer.get("exit"));
  return status instanceof PythonCrash ? status : undefined;
}

function printAnswer(answer: Map<string, Value>, secrets: Secrets, printer: Printer, call: Call, asJson: boolean, chars: bigint, command: string): Outcome {
  const invalid = asJson ? invalidReply(answer, secrets) : undefined;
  if (invalid !== undefined) {
    for (const [key, value] of cleanMetrics(answer.get("metrics"))) call.metrics.set(key, value);
    call.metrics.set("output_chars", chars);
    return { status: 1, crash: invalid };
  }
  if (asJson) codeJsonAnswer(answer, command);
  const code = answer.get("code");
  if (typeof code === "string") call.noteErrorCode(code);
  for (const [key, value] of cleanMetrics(answer.get("metrics"))) call.metrics.set(key, value);
  call.metrics.set("output_chars", chars);
  for (const [key, stream] of [["out", 1], ["err", 2]] as const) {
    const text = textOf(answer.get(key), secrets.known());
    if (text instanceof PythonCrash) return { status: 1, crash: text };
    const shown = text === "" ? "" : secrets.redact(text);
    if (stream === 1) printer.out(shown);
    else printer.err(shown);
    if (printer.stopped) return { status: printer.closed ? CLOSED : 1, crash: printer.crash };
  }
  const status = exitOf(answer.get("exit"));
  return status instanceof PythonCrash ? { status: 1, crash: status } : { status };
}

async function run(browse: string[], printer: Printer, call: Call, plugin: boolean, python: string | null): Promise<Outcome | undefined> {
  let parsed;
  try {
    parsed = splitGlobals(browse);
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    printError(new BrowseError(error.message, 1, undefined, "usage_error"), jsonIntent(browse), new Secrets(), printer, call);
    return { status: 1 };
  }
  const { found, rest } = parsed;
  const asJson = Boolean(found.flag("json")) || truthy(process.env.AGENT_BROWSER_JSON);
  const help = rest.length === 0 || HELP_WORDS.includes(rest[0] as string) ? rest[1] : rest.slice(1).some((word) => word === "--help" || word === "-h") && !["--version", "-V"].includes(rest[0] as string) ? rest[0] : null;
  if (help !== null) {
    const { commandHelp } = await import("./help.ts");
    printer.out(`${commandHelp(help)}\n`);
    return { status: printer.closed ? CLOSED : 0, crash: printer.crash };
  }
  if (rest[0] === "--version" || rest[0] === "-V") {
    printer.out(`ardia browse ${cliVersion()}\n`);
    return { status: printer.closed ? CLOSED : 0, crash: printer.crash };
  }
  let taken: [string[], string | null];
  try {
    taken = takeOut(browse, rest[0]);
  } catch (error) {
    if (!(error instanceof DaemonUsage)) throw error;
    printer.err(`✗ ${error.message}\n`);
    return { status: 1 };
  }
  const [stripped, outPath] = taken;
  const secrets = new Secrets();
  if (plugin) return { status: printError(new BrowseError(message(UNAVAILABLE_WHY), REFUSED, UNAVAILABLE), asJson, secrets, printer, call) };
  try {
    if (outPath !== null) {
      const command = rest[0] as string;
      const again = splitGlobals(AS_TEXT.includes(command) ? [...stripped, "--max-output", "0"] : ["--json", ...stripped]);
      const answer = await roundTrip(again.found, again.rest, secrets, call, python);
      return saveAnswer(answer, secrets, printer, call, command, outPath);
    }
    const answer = await roundTrip(found, rest, secrets, call, python);
    return printAnswer(answer, secrets, printer, call, asJson, outputChars(answer), rest[0] as string);
  } catch (error) {
    if (handBackReason(error) !== undefined) throw error;
    if (error instanceof PythonCrash) return { status: 1, crash: error };
    if (error instanceof Interrupted) {
      abandonWork();
      sayInterrupted(printer, asJson);
      return { status: INTERRUPTED };
    }
    if (error instanceof BrowseError) return { status: printError(error, asJson, secrets, printer, call) };
    if (error instanceof Usage) return { status: printError(new BrowseError(error.message, 1, undefined, "usage_error"), asJson, secrets, printer, call) };
    if (error instanceof Refused) return { status: printError(new BrowseError(error.message, 1, undefined, "invalid_name"), asJson, secrets, printer, call) };
    throw error;
  }
}

function refuse(asJson: boolean, why: string, call: Call, python: string | null, code = CODE, withUsage = true): number {
  const printer = new Printer("strict");
  call.noteErrorCode(code);
  if (asJson) {
    const payload = object([["success", false], ["data", null], ["error", message(why)], ["code", code]]);
    printer.out(`${dumps(payload, "compact")}\n`);
  } else printer.err(`✗ ${message(why)}\n`);
  finish(call, REFUSED, python, undefined, withUsage);
  return REFUSED;
}

function browseCall(argv: string[], browse: readonly string[] | undefined): Call {
  const call = new Call(argv);
  call.command = "browse";
  if (browse !== undefined) {
    call.subcommand = commandName(browse);
    call.allowedFlags = allowedFlags(call.subcommand);
  }
  return call;
}

export function refuseOrHandBack(argv: string[], python: string | null): number | undefined {
  if (!pluginMode()) return undefined;
  dropCredential();
  return refuse(jsonIntentOfArgv(argv), "needs text paths it can read without looking up another account", browseCall(argv, undefined), python);
}

function unreadableBeforeBrowse(argv: string[], python: string | null): number {
  const browseAt = argv.indexOf("browse");
  const leading = browseAt < 0 ? undefined : argv.slice(0, browseAt).find((token) => token.startsWith("-") && token !== "--json");
  const why = browseAt < 0 ? "runs only `ardia browse`" : leading !== undefined ? `can't read its options (ardia browse doesn't take ${leading.split("=")[0]} before browse)` : `can't read its options (${hoistFailure(argv).text.replace(/^✗ |^ardia: /, "").trim()})`;
  return refuse(plainJsonIntent(argv), why, browseCall(argv, undefined), python, CODE, false);
}

async function pluginAccess(browse: string[], call: Call, python: string | null): Promise<number | undefined> {
  try {
    await takeAccess();
    let parsed;
    try {
      parsed = splitGlobals(browse);
    } catch (error) {
      if (!(error instanceof Usage)) throw error;
      throw new PluginRefusal(`can't read its options (${error.message})`);
    }
    checkRequest(browse, parsed.found, parsed.rest);
    return undefined;
  } catch (error) {
    if (error instanceof PluginRefusal) return refuse(refusalJsonIntent(browse), error.message, call, python, error.code);
    if (error instanceof Interrupted) {
      abandonWork();
      sayInterrupted(new Printer("strict"), jsonIntent(browse));
      finish(call, INTERRUPTED, python);
      return INTERRUPTED;
    }
    throw error;
  }
}

export async function serveBrowse(argv: string[], python: string | null): Promise<number | undefined> {
  const plugin = pluginMode();
  const browse = hoist(argv);
  if (browse === undefined) {
    if (!plugin) {
      const failure = hoistFailure(argv);
      const call = new Call(argv);
      call.command = "none";
      toStderr(failure.text);
      finish(call, failure.status, python);
      return failure.status;
    }
    dropCredential();
    return unreadableBeforeBrowse(argv, python);
  }
  const call = browseCall(argv, browse);
  if (plugin) {
    const refused = await pluginAccess(browse, call, python);
    if (refused !== undefined) return refused;
  }
  if (!environmentIsText()) return plugin ? refuse(jsonIntent(browse), "needs text environment variables", call, python) : undefined;
  const errors = pythonStdioErrors();
  if (errors === undefined) return plugin ? refuse(jsonIntent(browse), "needs a UTF-8 locale", call, python) : undefined;
  const printer = new Printer(errors);
  let outcome: Outcome | undefined;
  try {
    outcome = await run(browse, printer, call, plugin, python);
  } catch (error) {
    const reason = handBackReason(error);
    if (reason === undefined) throw error;
    return plugin ? refuse(jsonIntent(browse), `can't run this here (${reason})`, call, python) : undefined;
  }
  if (outcome === undefined) return plugin ? refuse(jsonIntent(browse), "can't run this here", call, python) : undefined;
  let exit = typeof outcome.status === "bigint" ? processStatus(outcome.status) : outcome.status;
  if (outcome.crash !== undefined) exit = sayCrash(printer, outcome.crash, jsonIntent(browse));
  finish(call, outcome.status, python, outcome.crash?.crash);
  return exit === RESERVED_STATUS ? 1 : exit;
}
