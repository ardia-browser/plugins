import { osCrash } from "./crash.ts";
import { constants } from "node:os";
import type { Served } from "./argparse-cli.ts";
import { exceptionLine, inert, jsonSafe, reportCrash, stdoutFlushFailed, toStderr, writeAll, writeAsPythonBuffers } from "./printable.ts";
import { utf8 } from "./pystr.ts";
import { Call, finish } from "./telemetry.ts";

const BROKEN_PIPE = new Set(["EPIPE", "ESHUTDOWN"].map((name) => (constants.errno as Record<string, number>)[name]));

function jsonRequested(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).includes("--json");
}

function callFor(served: Served, argv: string[]): Call {
  const call = new Call(argv);
  call.command = served.command;
  call.subcommand = served.subcommand;
  call.allowedFlags = served.allowedFlags;
  call.noteErrorCode(served.errorCode);
  return call;
}

function complaintFailed(call: Call, errno: number, python: string | null): number {
  if (BROKEN_PIPE.has(errno)) {
    call.noteErrorCode("stdout_closed");
    finish(call, 141, python);
    return 141;
  }
  finish(call, 1, python, osCrash(errno));
  toStderr(exceptionLine(errno));
  return 1;
}

export function serveArgparse(served: Served, argv: string[], python: string | null): number {
  const call = callFor(served, argv);
  if (served.stderr !== "") {
    const errno = toStderr(inert(served.stderr));
    if (errno !== undefined && served.raisedByCli) return complaintFailed(call, errno, python);
  }
  if (served.stdout === "") {
    finish(call, served.status, python);
    return served.status;
  }
  const shown = utf8((jsonRequested(argv) ? jsonSafe : inert)(served.stdout));
  if (served.printedHelp) {
    const stop = writeAsPythonBuffers(shown);
    if (stop?.kind === "closed") {
      call.noteErrorCode("stdout_closed");
      finish(call, 141, python);
      return 141;
    }
    if (stop !== undefined) {
      finish(call, 1, python, osCrash(stop.errno));
      return reportCrash(stop.errno, stop.unwritten);
    }
    finish(call, served.status, python);
    return served.status;
  }
  try {
    writeAll(1, shown);
  } catch (error) {
    finish(call, served.status, python);
    return stdoutFlushFailed(error);
  }
  finish(call, served.status, python);
  return served.status;
}
