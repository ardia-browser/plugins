import argparse
import asyncio
import json
import math
import sys
from time import monotonic

from ardia_cli import control
from ardia_cli.control import MethodError, Unreachable
from ardia_cli.endpoint import DATA_DIR_HELP
from ardia_cli.printable import complain, say, shown

CALL_DESCRIPTION = """\
Send any method to the running Ardia over its control socket and print the result. Ardia's control socket reaches
the whole browser and every data point in the profile; `ardia methods` lists what this Ardia offers, with each
method's params, result and whether it changes anything.

Params come from --params (a JSON object, or - to read one from stdin) and -p (repeatable): -p key=value sets a
string, -p key:=value a JSON value (a number, true, null, an object or a list). -p wins over --params for the same key.

Params must be clean JSON: UTF-8, no lone surrogates, no NaN or Infinity, no number too large for a double, no key
twice, at most 64 levels deep, and not empty (send {} for no params). The whole request is at most 1 MB.

Exit status: 0 done, 1 Ardia refused or failed the method, 2 the params or options aren't valid (nothing was sent),
Ardia can't be reached, or the connection dropped after the request went out, or Ardia answered with neither a result
nor an error (so the method may or may not have run).

Examples:
  ardia methods
  ardia methods run
  ardia call windows --json
  ardia call run -p command=selectTab -p arg=3 -p window:=2
  ardia call run --params '{"command": "newTab"}'
  echo '{"command": "toggleSidebar"}' | ardia call run --params -
"""
METHODS_DESCRIPTION = """\
List the methods the running Ardia answers over its control socket (its `methods` method): name, whether it changes
anything, and what it does. With NAME, print that method's description, params schema and result. Send one with
`ardia call <method>`.

Exit status: 0 done, 1 this Ardia is too old to list its methods or has no method NAME, 2 Ardia can't be reached.
"""
TOO_OLD = ("this Ardia is too old to list its methods (it has no `methods` method): update Ardia. "
           "`ardia call` still sends the methods it knows: hello, commands, windows, workspace, apply, run, subscribe")
FAMILIES = frozenset({
    "hello", "caller", "commands", "windows", "workspace", "offscreen", "apply", "subscribe", "answer", "run", "methods",
    "app", "window", "tab", "tabs", "group", "groups", "folder", "folders", "pin", "pins", "space", "spaces", "profile",
    "profiles", "history", "bookmarks", "bookmark", "favorites", "cookies", "storage", "sitedata", "downloads",
    "download", "passwords", "password", "autofill", "permissions", "settings", "prefs", "preferences", "extensions",
    "extension", "search", "themes", "theme", "notes", "sessions", "session", "media", "notifications", "split",
    "peek", "sidebar", "command", "config", "plugins", "sync", "import", "certificates", "cache", "browser", "engine",
})
MAX_STDIN_PARAMS = 1024 * 1024
MAX_TIMEOUT = 600.0
PROTOCOL_CODES = frozenset({"bad_request", "unknown_method", "unknown_command", "refused", "no_window", "failed", "unsupported_protocol"})


class ParamsError(Exception):
    pass


def family(method: str) -> str:
    head = method.split(".", 1)[0].split("/", 1)[0].lower()
    return head if head in FAMILIES else "other"


def timeout_seconds(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"takes seconds, like 30 or 2.5, not {text}") from None
    if not math.isfinite(value) or value <= 0 or value > MAX_TIMEOUT:
        raise argparse.ArgumentTypeError(f"takes seconds above 0 and up to {MAX_TIMEOUT:g}, not {text}")
    return value


def recorded_code(code) -> str:
    return code if isinstance(code, str) and code in PROTOCOL_CODES else "other"


MAX_PARAMS_DEPTH = 64


def read_params_stdin(stdin=None) -> str:
    stream = stdin or sys.stdin
    binary = getattr(stream, "buffer", None)
    raw = binary.read(MAX_STDIN_PARAMS + 1) if binary is not None else stream.read(MAX_STDIN_PARAMS + 1).encode("utf-8", "surrogatepass")
    if len(raw) > MAX_STDIN_PARAMS:
        raise ParamsError("--params from stdin is over 1 MB")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ParamsError(f"--params from stdin isn't UTF-8 (byte 0x{raw[error.start]:02x} at offset {error.start})") from None


def strict_json(text: str, what: str):
    def unique(pairs):
        found = {}
        for key, value in pairs:
            if key in found:
                raise ParamsError(f"{what} has the key {json.dumps(key)} twice")
            found[key] = value
        return found

    def no_constant(name):
        raise ParamsError(f"{what} has {name}, which isn't JSON")

    def finite_float(literal):
        value = float(literal)
        if not math.isfinite(value):
            raise ParamsError(f"{what} has the number {literal[:24]}, which is too large for JSON")
        return value

    def bounded_int(literal):
        value = int(literal)
        try:
            float(value)
        except OverflowError:
            raise ParamsError(f"{what} has the number {literal[:24]}…, which is too large for JSON") from None
        return value

    if not text.strip():
        raise ParamsError(f"{what} is empty; give a JSON object, like {{}}")
    try:
        value = json.loads(text, object_pairs_hook=unique, parse_constant=no_constant, parse_float=finite_float, parse_int=bounded_int)
    except RecursionError:
        raise ParamsError(f"{what} is nested deeper than {MAX_PARAMS_DEPTH} levels") from None
    except ValueError as error:
        raise ParamsError(f"{what} isn't valid JSON ({error})") from None
    checked(value, what)
    return value


def checked(value, what: str) -> None:
    stack = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, (dict, list)):
            if depth >= MAX_PARAMS_DEPTH:
                raise ParamsError(f"{what} is nested deeper than {MAX_PARAMS_DEPTH} levels")
            if isinstance(item, dict):
                for key in item:
                    plain_text(key, what)
                stack.extend((child, depth + 1) for child in item.values())
            else:
                stack.extend((child, depth + 1) for child in item)
        elif isinstance(item, str):
            plain_text(item, what)
        elif isinstance(item, float) and not math.isfinite(item):
            raise ParamsError(f"{what} has a number that is too large for JSON")


def plain_text(text: str, what: str) -> None:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ParamsError(f"{what} has a lone surrogate (\\u{ord(text[error.start]):04x}), which isn't valid Unicode") from None


def build_params(raw: str | None, pairs: list[str], stdin=None) -> dict | None:
    params = None
    if raw is not None:
        if raw == "-":
            raw = read_params_stdin(stdin)
        params = strict_json(raw, "--params")
        if not isinstance(params, dict):
            raise ParamsError("--params must be a JSON object, like '{\"limit\": 10}'")
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key or key == ":":
            raise ParamsError(f"-p {pair}: give key=value, or key:=json")
        params = params if params is not None else {}
        if key.endswith(":"):
            key = key[:-1]
            plain_text(key, f"-p {key}")
            params[key] = strict_json(value, f"-p {key}: the value after :=")
        else:
            plain_text(key, f"-p {key}")
            plain_text(value, f"-p {key}")
            params[key] = value
    return params


def add_parsers(commands, formatter):
    call = commands.add_parser("call", help="send any method to Ardia's control socket (ardia methods lists them)", description=CALL_DESCRIPTION, formatter_class=formatter)
    call.add_argument("method", metavar="METHOD", help="a method name (see ardia methods)")
    call.add_argument("--params", metavar="JSON", help="the params, a JSON object (- reads it from stdin)")
    call.add_argument("-p", "--param", dest="pairs", action="append", default=[], metavar="KEY=VALUE", help="one param: key=value for a string, key:=json for any JSON value; repeatable")
    call.add_argument("--timeout", type=timeout_seconds, default=control.CALL_TIMEOUT, metavar="S",
                      help=f"how long to wait for the answer, in seconds (default {control.CALL_TIMEOUT:g}, at most {MAX_TIMEOUT:g})")
    call.add_argument("--json", action="store_true", help="print the result as JSON")
    call.add_argument("--data-dir", metavar="DIR", help=DATA_DIR_HELP)

    methods = commands.add_parser("methods", help="list the methods ardia call can send", description=METHODS_DESCRIPTION, formatter_class=formatter)
    methods.add_argument("name", nargs="?", metavar="NAME", help="show one method in full")
    methods.add_argument("--json", action="store_true", help="print JSON")
    methods.add_argument("--data-dir", metavar="DIR", help=DATA_DIR_HELP)


DESCRIPTOR_FIELDS = frozenset({"description", "mutates", "mutating", "params", "result", "area"})


def is_descriptor(value) -> bool:
    if not isinstance(value, dict) or not value or not set(value) <= DESCRIPTOR_FIELDS:
        return False
    if "description" in value and not isinstance(value["description"], str):
        return False
    return all(isinstance(value[key], bool) for key in ("mutates", "mutating") if key in value)


def is_wrapper(catalog) -> bool:
    if not isinstance(catalog, dict) or "methods" not in catalog:
        return False
    inner = catalog["methods"]
    if isinstance(inner, list):
        return True
    if not isinstance(inner, dict) or is_descriptor(inner):
        return False
    return not any(is_descriptor(value) for key, value in catalog.items() if key != "methods")


def entries(catalog) -> list[dict]:
    if is_wrapper(catalog):
        catalog = catalog["methods"]
    rows = []
    if isinstance(catalog, dict):
        for name, spec in catalog.items():
            rows.append({"name": str(name), **(spec if isinstance(spec, dict) else {"description": spec})})
    elif isinstance(catalog, list):
        for item in catalog:
            if isinstance(item, str):
                rows.append({"name": item})
            elif isinstance(item, dict):
                name = item.get("name") or item.get("method")
                if isinstance(name, str):
                    rows.append({**item, "name": name})
    return rows


def mutates(row: dict) -> bool:
    return bool(row.get("mutates") if "mutates" in row else row.get("mutating"))


def readable(value, indent: int = 0) -> list[str]:
    pad = "  " * indent
    if isinstance(value, dict):
        if not value:
            return [pad + "{}"]
        lines = []
        for key, item in value.items():
            if isinstance(item, (dict, list)) and item:
                lines.append(f"{pad}{shown(key)}:")
                lines.extend(readable(item, indent + 1))
            else:
                lines.append(f"{pad}{shown(key)}: {scalar(item)}")
        return lines
    if isinstance(value, list):
        if not value:
            return [pad + "[]"]
        lines = []
        for item in value:
            if isinstance(item, (dict, list)) and item:
                inner = readable(item, indent + 1)
                lines.append(f"{pad}- {inner[0].lstrip()}")
                lines.extend(inner[1:])
            else:
                lines.append(f"{pad}- {scalar(item)}")
        return lines
    return [pad + scalar(value)]


def scalar(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return shown(value)


def unreachable_exit(error: Unreachable, method: str | None = None) -> int:
    error.noted()
    if isinstance(error, control.InvalidAnswer) and method:
        complain(f"ardia call: {error}, so {method} may or may not have run")
    elif error.sent and method:
        complain(f"ardia call: the connection dropped after the request went out, so {method} may or may not have run ({error})")
    else:
        complain(f"ardia: {error}")
    return 2


def closest(name: str, catalog) -> str:
    from ardia_cli.schema_check import did_you_mean

    return did_you_mean(name, [row["name"] for row in entries(catalog)])


def cmd_call(args) -> int:
    from ardia_cli import telemetry

    telemetry.note_command("call", family(args.method), allowed_flags={"--params", "-p", "--param", "--timeout", "--json", "--data-dir"})
    try:
        plain_text(args.method, "METHOD")
        params = build_params(args.params, args.pairs)
        if len(control.request_line(control.WIDEST_ID, args.method, params)) > control.MAX_LINE:
            raise ParamsError("the request is over 1 MB, the most Ardia's control socket takes in one line")
    except ParamsError as error:
        telemetry.note_error_code("bad_params")
        complain(f"ardia call: {error}")
        return 2
    timeout = args.timeout

    async def work(connection):
        started = monotonic()
        try:
            return await connection.call(args.method, params, timeout, require_outcome=True), None
        except MethodError as error:
            catalog = None
            left = timeout - (monotonic() - started)
            if error.code == "unknown_method" and args.method != "methods" and left > 0:
                try:
                    catalog = await connection.call("methods", timeout=left)
                except (MethodError, Unreachable):
                    catalog = None
            return error, catalog

    try:
        result, catalog = asyncio.run(control.with_connection(args.data_dir, work))
    except Unreachable as error:
        return unreachable_exit(error, args.method)
    if isinstance(result, MethodError):
        telemetry.note_error_code(recorded_code(result.code))
        if catalog is not None:
            hint = closest(args.method, catalog)
        elif result.code == "unknown_method":
            hint = " (this Ardia can't list its methods, so it may be too old for this one: update Ardia)"
        else:
            hint = ""
        complain(f"ardia call: {result.message}{hint}")
        return 1
    if args.json:
        say(json.dumps(result, indent=2, ensure_ascii=False))
    elif result is None:
        say(f"✓ {shown(args.method)}")
    else:
        say("\n".join(readable(result)))
    return 0


def cmd_methods(args) -> int:
    from ardia_cli import telemetry

    try:
        catalog = control.call(args.data_dir, "methods")
    except Unreachable as error:
        return unreachable_exit(error)
    except MethodError as error:
        telemetry.note_error_code(recorded_code(error.code))
        if error.code == "unknown_method":
            telemetry.note_error_code("methods_unsupported")
            complain(f"ardia methods: {TOO_OLD}")
        else:
            complain(f"ardia methods: {error.message}")
        return 1
    rows = entries(catalog)
    if args.name:
        row = next((r for r in rows if r["name"] == args.name), None)
        if row is None:
            complain(f"ardia methods: Ardia has no method {args.name}{closest(args.name, catalog)}")
            return 1
        if args.json:
            say(json.dumps(row, indent=2, ensure_ascii=False))
            return 0
        say(describe(row))
        return 0
    if args.json:
        say(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    width = min(max((len(r["name"]) for r in rows), default=0), 40)
    for row in rows:
        mark = "changes" if mutates(row) else "reads  "
        say(shown(f"{row['name'].ljust(width)}  {mark}  {row.get('description') or ''}".rstrip()))
    return 0


def describe(row: dict) -> str:
    lines = [shown(row["name"]) + ("  (changes things)" if mutates(row) else "  (reads only)")]
    if row.get("description"):
        lines.append(shown(row["description"]))
    for key, title in (("params", "params"), ("result", "result")):
        if key in row and row[key] is not None:
            lines.append(f"{title}:")
            lines.extend(readable(row[key], 1))
    shown_keys = {"name", "description", "params", "result", "mutates", "mutating"}
    extra = {k: v for k, v in row.items() if k not in shown_keys}
    if extra:
        lines.extend(readable(extra))
    return "\n".join(lines)


def run(args) -> int:
    try:
        return (cmd_call if args.command == "call" else cmd_methods)(args)
    except KeyboardInterrupt:
        complain(f"ardia {args.command}: interrupted")
        return 130
