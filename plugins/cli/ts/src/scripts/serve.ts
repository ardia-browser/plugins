import { interrupted } from "../control.ts";
import { toStderr } from "../printable.ts";
import { Call, finish } from "../telemetry.ts";
import { allowedFlags, jsonRequested, type ScriptsArgs } from "./args.ts";
import { type Ending, runChange, runList, runNew } from "./commands.ts";
import { BrokenPipe, Interrupted, Say } from "./output.ts";

const EXIT_FLUSH_FAILED = 120;
const FLUSH_FAILURE = "Exception ignored on flushing sys.stdout:\nBrokenPipeError: [Errno 32] Broken pipe\n";

async function run(args: ScriptsArgs, out: Say): Promise<Ending> {
  if (args.sub === "new") return { status: runNew(args, out) };
  if (args.sub === "list") return { status: await runList(args, out) };
  return runChange(args, out);
}

function dieByInterrupt(): never {
  toStderr("KeyboardInterrupt\n");
  process.removeAllListeners("SIGINT");
  process.kill(process.pid, "SIGINT");
  process.exit(130);
}

export async function serveScripts(args: ScriptsArgs, argv: string[], python: string | null): Promise<number> {
  const call = new Call(argv);
  call.command = "scripts";
  call.subcommand = args.sub;
  call.allowedFlags = allowedFlags(args.sub);
  const out = new Say(jsonRequested(argv));
  let ending: Ending;
  try {
    ending = await run(args, out);
    if (interrupted()) throw new Interrupted();
  } catch (error) {
    if (error instanceof Interrupted) {
      finish(call, 130, python);
      dieByInterrupt();
    }
    if (!(error instanceof BrokenPipe)) throw error;
    call.noteErrorCode("stdout_closed");
    finish(call, 141, python);
    return 141;
  }
  finish(call, ending.status, python);
  if (ending.exitFlushFails) {
    toStderr(FLUSH_FAILURE);
    return EXIT_FLUSH_FAILED;
  }
  return ending.status;
}
