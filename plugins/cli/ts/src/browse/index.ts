import { NeedsPython } from "../paths.ts";
import { abandonWork } from "../printable.ts";
import { Call, finish } from "../telemetry.ts";
import { cliVersion } from "../version.ts";
import { cleanMetrics, exitOf, outputChars, processStatus, textOf } from "./answer.ts";
import { allowedFlags, commandName, hoist, splitGlobals, truthy, Usage } from "./args.ts";
import { BrowseError, PythonCrash } from "./errors.ts";
import { Interrupted } from "./exchange.ts";
import { Printer } from "./output.ts";
import { dropCredential, pluginMode, pluginModeValueOk, PluginRefusal, REFUSED, refusal, takeCredential } from "./plugin.ts";
import { PLUGIN_MODE } from "./route.ts";
import { Secrets } from "./redact.ts";
import { renderError } from "./render.ts";
import { environmentIsText, Refused, Unported } from "./request.ts";
import { handedBack, HandBack, roundTrip } from "./serve.ts";
import { NoDaemon } from "./session.ts";
import { pythonStdioErrors } from "./stdio.ts";

const HELP_WORDS = ["help", "--help", "-h"];
const CLOSED = 141;
const INTERRUPTED = 130;
const RESERVED_STATUS = 253;

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

function printAnswer(answer: Map<string, import("../json.ts").Value>, secrets: Secrets, printer: Printer, call: Call): Outcome {
  const code = answer.get("code");
  if (typeof code === "string") call.noteErrorCode(code);
  for (const [key, value] of cleanMetrics(answer.get("metrics"))) call.metrics.set(key, value);
  call.metrics.set("output_chars", outputChars(answer));
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

async function run(browse: string[], printer: Printer, call: Call, credential: string | undefined): Promise<Outcome | undefined> {
  let parsed;
  try {
    parsed = splitGlobals(browse);
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    printer.err(`✗ ${error.message}\n`);
    return { status: 1 };
  }
  const { found, rest } = parsed;
  const asJson = Boolean(found.flag("json")) || truthy(process.env.AGENT_BROWSER_JSON);
  if (rest.length === 0 || HELP_WORDS.includes(rest[0] as string)) return undefined;
  if (rest[0] === "--version" || rest[0] === "-V") {
    printer.out(`ardia browse ${cliVersion()}\n`);
    return { status: printer.closed ? CLOSED : 0, crash: printer.crash };
  }
  if (rest.slice(1).includes("--help") || rest.slice(1).includes("-h")) return undefined;
  if (handedBack(rest, browse) !== undefined) return undefined;
  const secrets = new Secrets();
  try {
    const answer = await roundTrip(found, rest, secrets, call, credential);
    return printAnswer(answer, secrets, printer, call);
  } catch (error) {
    if (handBackReason(error) !== undefined) throw error;
    if (error instanceof PluginRefusal) throw error;
    if (error instanceof PythonCrash) return { status: 1, crash: error };
    if (error instanceof Interrupted) {
      abandonWork();
      printer.err("✗ interrupted\n");
      return { status: INTERRUPTED };
    }
    if (error instanceof BrowseError) return { status: printError(error, asJson, secrets, printer, call) };
    if (error instanceof Usage || error instanceof Refused) return { status: printError(new BrowseError(error.message), asJson, secrets, printer, call) };
    throw error;
  }
}

function refuse(why: string, call: Call | undefined, python: string | null): number {
  const printer = new Printer("strict");
  printer.err(refusal(why));
  if (call !== undefined) {
    call.noteErrorCode("plugin_refused");
    finish(call, REFUSED, python);
  }
  return REFUSED;
}

function pluginCall(argv: string[]): Call {
  const call = new Call(argv);
  call.command = "browse";
  call.metrics.set("plugin_mode", true);
  return call;
}

export function refuseOrHandBack(argv: string[], python: string | null): number | undefined {
  if (!pluginMode()) return undefined;
  dropCredential();
  const call = pluginCall(argv);
  return refuse("needs text paths and readable telemetry consent", call, python);
}

export async function serveBrowse(argv: string[], python: string | null): Promise<number | undefined> {
  const plugin = pluginMode();
  let credential: string | undefined;
  if (plugin) {
    if (!pluginModeValueOk()) {
      dropCredential();
      return refuse(`takes ${PLUGIN_MODE}=1 only, not ${JSON.stringify(process.env[PLUGIN_MODE])}`, pluginCall(argv), python);
    }
    try {
      credential = await takeCredential();
    } catch (error) {
      if (error instanceof PluginRefusal) return refuse(error.message, pluginCall(argv), python);
      throw error;
    }
  }
  const browse = hoist(argv);
  if (browse === undefined) return plugin ? refuse("can't read these arguments", undefined, python) : undefined;
  const call = new Call(argv);
  call.command = "browse";
  call.subcommand = commandName(browse);
  call.allowedFlags = allowedFlags(call.subcommand);
  if (plugin) call.metrics.set("plugin_mode", true);
  if (!environmentIsText()) return plugin ? refuse("needs text environment variables", call, python) : undefined;
  const errors = pythonStdioErrors();
  if (errors === undefined) return plugin ? refuse("needs a UTF-8 locale", call, python) : undefined;
  const printer = new Printer(errors);
  let outcome: Outcome | undefined;
  try {
    outcome = await run(browse, printer, call, credential);
  } catch (error) {
    if (error instanceof PluginRefusal) return refuse(error.message, call, python);
    const reason = handBackReason(error);
    if (reason === undefined) throw error;
    if (!plugin) return undefined;
    if (error instanceof NoDaemon) return refuse("found no running browse session for this activity (Ardia starts it for the plugin)", call, python);
    return refuse(`can't run this yet (${reason})`, call, python);
  }
  if (outcome === undefined) return plugin ? refuse("doesn't serve help or local commands yet", call, python) : undefined;
  let exit = typeof outcome.status === "bigint" ? processStatus(outcome.status) : outcome.status;
  if (outcome.crash !== undefined) exit = printer.sayCrash(outcome.crash);
  finish(call, outcome.status, python, outcome.crash?.crash);
  return exit === RESERVED_STATUS ? 1 : exit;
}
