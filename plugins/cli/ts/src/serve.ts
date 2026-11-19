import { call as callControl, ControlFailure, errorCode, type Failure, interrupted } from "./control.ts";
import { render as renderHelp } from "./help.ts";
import type { Value } from "./json.ts";
import { failed, type Kind, type Listing, methodFailed, methodOf, paramsOf, type Rendered } from "./listing.ts";
import { codeOf, errnoOf, NeedsPython } from "./paths.ts";
import { inert, Output, pythonStdoutBuffer, reportCrash, stdoutFlushFailed, writeAll } from "./printable.ts";
import { utf8 } from "./pystr.ts";
import { Unsupported } from "./py.ts";
import { render } from "./render.ts";
import { Call, finish } from "./telemetry.ts";

const TOP_FLAGS = ["-h", "--help", "--version", "--skill"];
const LISTING_FLAGS = [...TOP_FLAGS, "--data-dir", "--json"];
const GROUPS_FLAGS = [...LISTING_FLAGS, "--window", "--profile"];
const TABS_FLAGS = [...GROUPS_FLAGS, "--flat", "--usage", "--pid"];

export function serveHelp(argv: string[], python: string | null): number | undefined {
  const text = renderHelp();
  if (text === undefined) return undefined;
  const call = new Call(argv);
  call.allowedFlags = TOP_FLAGS;
  const shown = utf8(inert(text));
  try {
    writeAll(1, shown);
  } catch (error) {
    if (argv.length > 0) {
      finish(call, 0, python);
      return stdoutFlushFailed(error);
    }
    const code = codeOf(error);
    if (code === "EPIPE" || code === "ESHUTDOWN") {
      call.noteErrorCode("stdout_closed");
      finish(call, 141, python);
      return 141;
    }
    const errno = errnoOf(error);
    const exit = reportCrash(errno, shown.length <= pythonStdoutBuffer());
    finish(call, 1, python, errno);
    return exit;
  }
  finish(call, 0, python);
  return 0;
}

function allowedFor(kind: Kind): string[] {
  if (kind === "tabs") return TABS_FLAGS;
  return kind === "groups" ? GROUPS_FLAGS : LISTING_FLAGS;
}

type Reply = { ok: true; result: Value } | { ok: false; failure: Failure };

async function ask(kind: Kind, listing: Listing): Promise<Reply> {
  try {
    return { ok: true, result: await callControl(listing.dataDir, methodOf(kind), paramsOf(kind, listing)) };
  } catch (error) {
    if (error instanceof ControlFailure) return { ok: false, failure: error.failure };
    throw error;
  }
}

function renderReply(kind: Kind, listing: Listing, reply: Reply): Rendered | undefined {
  if (reply.ok) {
    const result = reply.result;
    if ((kind === "tabs" || kind === "groups") && (typeof result === "boolean" || typeof result === "bigint")) return undefined;
    try {
      return render(kind, listing, result);
    } catch (error) {
      if (error instanceof Unsupported) return undefined;
      throw error;
    }
  }
  const failure = reply.failure;
  switch (failure.kind) {
    case "unreachable":
    case "incompatible":
      return failed(2, errorCode(failure), `ardia: ${failure.message}`);
    case "method":
      return methodFailed(kind, listing, failure.code, failure.message);
    case "interrupted":
      return failed(130, undefined, `ardia ${kind}: interrupted`);
    case "unported":
      return undefined;
  }
}

export async function serveListing(kind: Kind, listing: Listing, argv: string[], python: string | null): Promise<number | undefined> {
  const call = new Call(argv);
  call.command = kind;
  call.allowedFlags = allowedFor(kind);
  let reply: Reply;
  try {
    reply = await ask(kind, listing);
  } catch (error) {
    if (error instanceof NeedsPython) return undefined;
    throw error;
  }
  if (interrupted()) reply = { ok: false, failure: { kind: "interrupted" } };
  const shown = renderReply(kind, listing, reply);
  if (shown === undefined) return undefined;
  const out = new Output(listing.json);
  let status = shown.status;
  call.noteErrorCode(shown.errorCode);
  for (const line of shown.lines) {
    out.say(line);
    if (out.closed) break;
  }
  await out.flush();
  if (out.interrupted) {
    status = 130;
    out.complain(`ardia ${kind}: interrupted`);
  } else if (out.closed) {
    call.noteErrorCode("stdout_closed");
    status = 141;
  } else {
    const crashed = out.pythonCrash();
    if (crashed !== undefined) {
      finish(call, 1, python, crashed.errno);
      return crashed.exit;
    }
    if (shown.complaint !== undefined) out.complain(shown.complaint);
  }
  finish(call, status, python);
  return status;
}
