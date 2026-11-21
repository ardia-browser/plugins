import os from "node:os";
import { errnoOf, strerror } from "./paths.ts";
import { reprStr } from "./py.ts";

const SIGNAL_NAMES = new Map<number, string>(Object.entries(os.constants.signals).map(([name, value]) => [value, name]));

export function osErrorText(error: unknown): string {
  const errno = errnoOf(error);
  if (errno === 0) return error instanceof Error ? error.message : String(error);
  const details = error as { path?: unknown; dest?: unknown };
  const head = `[Errno ${errno}] ${strerror(errno)}`;
  if (typeof details.path !== "string") return head;
  if (typeof details.dest === "string") return `${head}: ${reprStr(details.path)} -> ${reprStr(details.dest)}`;
  return `${head}: ${reprStr(details.path)}`;
}

export function strerrorOr(error: unknown): string {
  const errno = errnoOf(error);
  return errno === 0 ? osErrorText(error) : strerror(errno);
}

export function argvRepr(argv: readonly string[]): string {
  return `[${argv.map(reprStr).join(", ")}]`;
}

export function calledProcessText(argv: readonly string[], code: number): string {
  if (code < 0) {
    const name = SIGNAL_NAMES.get(-code);
    return `Command '${argvRepr(argv)}' died with ${name === undefined ? `unknown signal ${-code}` : `<Signals.${name}: ${-code}>`}.`;
  }
  return `Command '${argvRepr(argv)}' returned non-zero exit status ${code}.`;
}

export function timeoutText(argv: readonly string[], seconds: number): string {
  return `Command '${argvRepr(argv)}' timed out after ${seconds} seconds`;
}

export function spawnErrorText(argv: readonly string[], errno: number): string {
  return `[Errno ${errno}] ${strerror(errno)}: ${reprStr(argv[0] ?? "")}`;
}
