import { environment, knownParsers } from "./argparse-env.ts";
import { BOOL_FLAGS, COMMAND_FLAGS, KNOWN_COMMANDS, LAUNCH_ONLY, VALUE_FLAGS } from "./browse/tables.ts";
import { CALL_FLAGS, FAMILIES } from "./call-cli.ts";
import { DRIVER_COMMANDS } from "./computer/label.ts";
import { servedTable } from "./served.ts";

export const OTHER_NAME = "other";

export const EXCEPTION_TYPES: ReadonlySet<string> = new Set([
  "ArgumentError", "ArgumentTypeError", "ArithmeticError", "AssertionError", "AttributeError", "BadZipFile", "BaseException",
  "BaseExceptionGroup", "BlockingIOError", "BrokenPipeError", "BrowseError", "BufferError", "BytesWarning", "CalledProcessError",
  "CancelledError", "ChildProcessError", "CompressionError", "ConfigError", "ConnectionAbortedError", "ConnectionClosed",
  "ConnectionError", "ConnectionRefusedError", "ConnectionResetError", "DatabaseError", "DeprecationWarning", "EOFError",
  "EncodingWarning", "EndpointError", "EnvironmentError", "Error", "Exception", "ExceptionGroup", "ExpatError", "FileExistsError",
  "FileNotFoundError", "FloatingPointError", "FutureWarning", "GeneratorExit", "HTTPError", "HTTPException", "HeaderError",
  "HooksError", "IOError", "ImportError", "ImportWarning", "IncompleteRead", "IncompleteReadError", "IndentationError", "IndexError",
  "IntegrityError", "InterruptedError", "InvalidFileException", "InvalidHandshake", "InvalidMessage", "InvalidStateError",
  "InvalidStatus", "InvalidURI", "InvalidURL", "IsADirectoryError", "JSONDecodeError", "KeyError", "KeyboardInterrupt",
  "LimitOverrunError", "LookupError", "MemoryError", "ModuleNotFoundError", "NameError", "NotADirectoryError",
  "NotImplementedError", "OSError", "OperationalError", "OverflowError", "PathError", "PatternError", "PayloadTooBig",
  "PendingDeprecationWarning", "PermissionError", "PluginError", "ProcessLookupError", "ProgrammingError", "ProtocolError",
  "PythonFinalizationError", "ReadError", "RecursionError", "ReferenceError", "RemoteDisconnected", "ResourceWarning",
  "RuntimeError", "RuntimeWarning", "SSLCertVerificationError", "SSLError", "ScriptError", "StopAsyncIteration", "StopIteration",
  "SyntaxError", "SyntaxWarning", "SystemError", "SystemExit", "TabError", "TimeoutError", "TimeoutExpired", "TypeError",
  "URLError", "UnboundLocalError", "UnicodeDecodeError", "UnicodeEncodeError", "UnicodeError", "UnicodeTranslateError",
  "UnicodeWarning", "Usage", "UsageError", "UserWarning", "ValueError", "Warning", "ZeroDivisionError", "ZoneInfoNotFoundError",
  "gaierror", "herror",
]);

export const EXCEPTION_SOURCES: ReadonlySet<string> = new Set(["cli_unhandled", "browse_daemon"]);

type Names = { commands: Set<string>; subcommands: Set<string>; flags: Set<string> };

let names: Names | undefined;

function build(): Names {
  const commands = new Set<string>(["none", "help", "version", OTHER_NAME]);
  const subcommands = new Set<string>(["help", "version", OTHER_NAME, "setup", "refresh", ...KNOWN_COMMANDS, ...FAMILIES, ...DRIVER_COMMANDS]);
  const flags = new Set<string>([...VALUE_FLAGS, ...BOOL_FLAGS, ...LAUNCH_ONLY, ...CALL_FLAGS, ...Object.values(COMMAND_FLAGS).flat(), "--skill", "--version", "-h", "--help"]);
  for (const linux of [false, true]) {
    const env = environment({ linux });
    for (const parser of knownParsers(linux)) {
      const words = parser.split(" ").slice(1);
      if (words[0] !== undefined) commands.add(words[0]);
      if (words[1] !== undefined) subcommands.add(words[1]);
      for (const action of env.parser(parser).actions) for (const option of action.option_strings) flags.add(option);
    }
  }
  for (const label of servedTable().keys()) {
    const [command, sub] = label.split(" ");
    if (command !== undefined && !command.includes("-")) commands.add(command);
    if (command !== undefined && command.startsWith("--")) continue;
    if (sub !== undefined && sub !== "*") subcommands.add(sub);
  }
  return { commands, subcommands, flags };
}

function known(): Names {
  names ??= build();
  return names;
}

export function knownCommand(value: string): string {
  return known().commands.has(value) ? value : OTHER_NAME;
}

export function knownSubcommand(value: string): string {
  return known().subcommands.has(value) ? value : OTHER_NAME;
}

export function knownFlags(list: string): string {
  if (list === "") return "";
  return list.split(",").filter((flag) => known().flags.has(flag)).join(",");
}

export function knownExceptionType(value: string): string {
  return EXCEPTION_TYPES.has(value) ? value : OTHER_NAME;
}
