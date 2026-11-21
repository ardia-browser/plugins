import { read } from "node:fs";
import { constants } from "node:os";
import { ControlFailure, errorCode, type Failure, interrupted } from "./control.ts";
import { abandonPendingRead, exceptionLine, jsonSafe, Output, toStderr } from "./printable.ts";
import { Call, finish } from "./telemetry.ts";

export class HandBack extends Error {}

export class Interrupted extends Error {}

class StdoutClosed extends Error {}

class OutputFailed extends Error {}

class ComplaintFailed extends Error {
  constructor(readonly errno: number) {
    super("stderr");
  }
}

const COUNTS = new Set(["batch_steps"]);
const MAX_COUNT = 100_000_000;
const STDIN_POLL_MS = 50;
const BROKEN_PIPE = new Set(["EPIPE", "ESHUTDOWN"].map((name) => (constants.errno as Record<string, number>)[name]));

export class Context {
  private readonly out: Output;
  private sideEffects = false;

  constructor(
    readonly call: Call,
    readonly json: boolean,
  ) {
    this.out = new Output(json);
  }

  async say(text: string): Promise<void> {
    this.out.say(this.json ? jsonSafe(text) : text);
    await this.out.flush();
    if (this.out.interrupted) throw new Interrupted();
    if (this.out.closed) throw new StdoutClosed();
    if (this.out.failed !== undefined) throw new OutputFailed();
  }

  complain(text: string): void {
    const errno = this.out.complain(text);
    if (errno !== undefined) throw new ComplaintFailed(errno);
  }

  noteErrorCode(code: string | undefined): void {
    this.call.noteErrorCode(code);
  }

  noteCount(key: string, value: number): void {
    if (!COUNTS.has(key) || !Number.isFinite(value)) return;
    const kept = BigInt(Math.min(Math.max(Math.round(value), 0), MAX_COUNT));
    this.call.metrics = [...this.call.metrics.filter(([name]) => name !== key), [key, kept]];
  }

  committed(): void {
    this.sideEffects = true;
  }

  get handBackAllowed(): boolean {
    return !this.sideEffects;
  }

  reportCrash(): number {
    return this.out.reportCrash();
  }

  get failedErrno(): number | undefined {
    return this.out.failed?.errno;
  }
}

export function failureOf(error: unknown, context?: Context): Failure | undefined {
  if (!(error instanceof ControlFailure)) return undefined;
  const failure = error.failure;
  if (failure.kind === "interrupted") throw new Interrupted();
  if (failure.kind === "unported") {
    if (context === undefined || context.handBackAllowed || failure.code === undefined || failure.message === undefined) throw new HandBack();
    return { kind: "method", code: failure.code, message: failure.message };
  }
  return failure;
}

export function noteUnreachable(context: Context, failure: Failure): void {
  context.noteErrorCode(errorCode(failure));
}

export function checkInterrupt(): void {
  if (interrupted()) throw new Interrupted();
}

export type Command = {
  command: string;
  subcommand: string | undefined;
  allowedFlags: readonly string[];
  topWord: string;
  json: boolean;
  run(context: Context): Promise<number>;
};

function complaintFailed(call: Call, errno: number, python: string | null): number {
  if (BROKEN_PIPE.has(errno)) {
    call.noteErrorCode("stdout_closed");
    finish(call, 141, python);
    return 141;
  }
  finish(call, 1, python, errno);
  toStderr(exceptionLine(errno));
  return 1;
}

export async function runCommand(command: Command, argv: string[], python: string | null): Promise<number | undefined> {
  const call = new Call(argv);
  call.command = command.command;
  call.subcommand = command.subcommand;
  call.allowedFlags = command.allowedFlags;
  const context = new Context(call, command.json);
  let status: number;
  try {
    try {
      status = await command.run(context);
      checkInterrupt();
    } catch (error) {
      if (error instanceof ControlFailure && error.failure.kind === "interrupted") throw new Interrupted();
      throw error;
    }
  } catch (error) {
    if (error instanceof HandBack && context.handBackAllowed) return undefined;
    if (error instanceof StdoutClosed) {
      call.noteErrorCode("stdout_closed");
      status = 141;
    } else if (error instanceof Interrupted) {
      try {
        context.complain(`ardia ${command.topWord}: interrupted`);
      } catch (inner) {
        if (inner instanceof ComplaintFailed) return complaintFailed(call, inner.errno, python);
        throw inner;
      }
      status = 130;
    } else if (error instanceof OutputFailed) {
      finish(call, 1, python, context.failedErrno);
      return context.reportCrash();
    } else if (error instanceof ComplaintFailed) {
      return complaintFailed(call, error.errno, python);
    } else throw error;
  }
  finish(call, status, python);
  return status;
}

export async function readStdin(limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, limit - total));
    const settled = new Promise<number>((resolve, reject) => read(0, chunk, 0, chunk.length, null, (error, count) => (error ? reject(error) : resolve(count))));
    let count: number | undefined;
    let failure: unknown;
    settled.then(
      (value) => {
        count = value;
      },
      (error: unknown) => {
        failure = error ?? new Error("read");
      },
    );
    while (count === undefined && failure === undefined) {
      if (interrupted()) {
        abandonPendingRead();
        throw new Interrupted();
      }
      await Promise.race([settled.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, STDIN_POLL_MS))]);
    }
    if (failure !== undefined) {
      const code = (failure as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EINTR") {
        await new Promise((resolve) => setTimeout(resolve, STDIN_POLL_MS));
        continue;
      }
      throw failure;
    }
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count as number;
  }
  return Buffer.concat(chunks);
}
