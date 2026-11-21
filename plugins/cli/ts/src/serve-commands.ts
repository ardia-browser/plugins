import { CommandIo, jsonRequested } from "./cmdio.ts";
import { crashValue } from "./crash.ts";
import { NeedsPython } from "./paths.ts";
import { PythonError } from "./py.ts";
import { toStderr } from "./printable.ts";
import { pythonOsError } from "./printable.ts";
import { errnoOf, strerror } from "./paths.ts";
import { Call, finish } from "./telemetry.ts";

export type CommandRoute = { kind: "computer"; argv: string[] } | { kind: "hooks"; verb: string; argv: string[] } | { kind: "on"; argv: string[] };

async function settled(io: CommandIo, call: Call, run: () => Promise<number>, python: string | null): Promise<number | undefined> {
  let status: number;
  try {
    status = await run();
  } catch (error) {
    if (error instanceof NeedsPython) return undefined;
    if (!(error instanceof PythonError)) throw error;
    io.settle(1);
    toStderr(`${error.message}\n`);
    finish(call, 1, python, { kind: error.kind, value: crashValue(error.kind, error.text) });
    return 1;
  }
  if (io.exec !== undefined) {
    const shown = io.settle(0);
    finish(call, 0, python);
    if (shown !== 0) return shown;
    const { execDriver } = await import("./computer/cli.ts");
    try {
      execDriver(io.exec);
    } catch (error) {
      const errno = errnoOf(error);
      toStderr(`${pythonOsError(errno)}: [Errno ${errno}] ${strerror(errno)}: '${io.exec.binary}'\n`);
      return 1;
    }
  }
  status = io.settle(status);
  call.noteErrorCode(io.errorCode);
  finish(call, status, python);
  return status;
}

export async function serveCommand(route: CommandRoute, argv: string[], python: string | null): Promise<number | undefined> {
  const call = new Call(argv);
  const io = new CommandIo(jsonRequested(argv));
  if (route.kind === "computer") {
    const { computerMain, label } = await import("./computer/cli.ts");
    call.command = "computer";
    call.subcommand = label(route.argv);
    return settled(io, call, () => computerMain(io, route.argv), python);
  }
  const { serveHooks } = await import("./hooks/cli.ts");
  return serveHooks(route, argv, call, io, python, (run) => settled(io, call, run, python));
}
