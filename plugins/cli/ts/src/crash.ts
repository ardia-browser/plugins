import { type JsonObject, object, type Value } from "./json.ts";
import { strerror } from "./libc.ts";
import { pythonOsError } from "./printable.ts";
import { cliVersion } from "./version.ts";

const MECHANISM = "cli_unhandled";

export function exceptionProperties(errno: number, environment: string): [string, Value][] {
  const kind = pythonOsError(errno);
  const value = `[Errno ${errno}] ${strerror(errno)}`;
  const entry: JsonObject = object([
    ["type", kind],
    ["value", value],
    ["mechanism", object([["type", MECHANISM], ["handled", false], ["synthetic", false]])],
    ["stacktrace", object([["type", "raw"], ["frames", []]])],
  ]);
  return [
    ["$exception_level", "fatal"],
    ["source", MECHANISM],
    ["$exception_types", [kind]],
    ["$exception_values", [value]],
    ["$exception_list", [entry]],
    ["error_code", null],
    ["cli_version", cliVersion()],
    ["$environment", environment],
  ];
}
