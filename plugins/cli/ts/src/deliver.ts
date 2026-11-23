import { osCrash } from "./crash.ts";
import { constants } from "node:os";
import { exceptionLine, inert, Output, toStderr } from "./printable.ts";
import { type Call, finish } from "./telemetry.ts";

export type Said = { status: number; out: string[]; err: string[]; raw?: string };

const BROKEN_PIPE = new Set(["EPIPE", "ESHUTDOWN"].map((name) => (constants.errno as Record<string, number>)[name]));

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

export async function deliver(call: Call, said: Said, json: boolean, python: string | null): Promise<number> {
  const out = new Output(json);
  let status = said.status;
  if (said.raw !== undefined) out.write(said.raw);
  for (const line of said.out) {
    out.say(line);
    if (out.closed) break;
  }
  await out.flush(() => false);
  if (out.closed) {
    call.noteErrorCode("stdout_closed");
    status = 141;
  } else if (out.failed !== undefined) {
    finish(call, 1, python, osCrash(out.failed.errno));
    return out.reportCrash();
  } else {
    for (const line of said.err) {
      const errno = out.complain(line);
      if (errno !== undefined) return complaintFailed(call, errno, python);
    }
  }
  finish(call, status, python);
  return status;
}

export function usageFailure(call: Call, message: string, python: string | null): number {
  const errno = toStderr(`${inert(`ardia: ${message}`)}\n`);
  if (errno !== undefined) return complaintFailed(call, errno, python);
  finish(call, 2, python);
  return 2;
}
