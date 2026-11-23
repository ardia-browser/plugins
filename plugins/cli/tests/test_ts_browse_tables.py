import json
import re
import sys
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
TABLES = CLI / "ts" / "src" / "browse" / "tables.ts"
HELP = CLI / "ts" / "src" / "browse" / "help-text.ts"
REGENERATE = "python -c 'from tests.test_ts_browse_tables import ts_tables; print(ts_tables(), end=\"\")' > ts/src/browse/tables.ts"


def words(name: str, values) -> str:
    return f"export const {name}: readonly string[] = {json.dumps(sorted(values), ensure_ascii=False)};\n"


def pairs(name: str, mapping: dict) -> str:
    rows = json.dumps(dict(sorted(mapping.items())), ensure_ascii=False)
    return f"export const {name}: Readonly<Record<string, string>> = {rows};\n"


def number(name: str, value: int) -> str:
    return f"export const {name} = {value};\n"


def text(name: str, value: str) -> str:
    return f"export const {name} = {json.dumps(value, ensure_ascii=False)};\n"


def known_browse_commands() -> list:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli import telemetry

    aliases, known = telemetry.browse_names()
    return sorted(known | set(aliases) | set(TS_HELP_COMMANDS))


DAEMON_METRICS = CLI / "ts" / "src" / "browse" / "metrics.ts"


def daemon_metric_sets(*names: str) -> set:
    source = DAEMON_METRICS.read_text(encoding="utf-8")
    found = set()
    for name in names:
        body = re.search(rf"export const {name} = new Set\(\[(.*?)\]\);", source, re.S)
        if body is None:
            raise AssertionError(f"{DAEMON_METRICS.name} has no {name} set")
        found |= set(re.findall(r'"([a-z0-9_]+)"', body.group(1)))
    return found


def ts_tables() -> str:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli import command_metrics, telemetry, usage
    from ardia_cli.browse import cli as browse_cli, help as browse_help, limits, outfile
    from ardia_cli.browse.commands import ALIASES, MUTATING

    shared = browse_cli.VALUE_FLAGS | browse_cli.BOOL_FLAGS
    local = {name: sorted(set(re.findall(r"(?<![\w-])(--?[a-z][a-z0-9-]*)", with_ts_additions(name, usage_text))) - shared)
             for name, usage_text in sorted({**browse_help.COMMANDS, **TS_HELP_COMMANDS}.items())}
    owns = {name: sorted(flags) for name, flags in sorted(browse_cli.COMMAND_OWNS.items())}
    flags = (command_metrics.FLAGS | command_metrics.READ_FLAGS | command_metrics.ACT_FLAGS | command_metrics.CHANGE_FLAGS
             | command_metrics.FLOW_FLAGS)
    counts = command_metrics.COUNTS | command_metrics.ACT_COUNTS | command_metrics.CHANGE_COUNTS | command_metrics.FLOW_COUNTS
    flags |= daemon_metric_sets("FLAGS", "READ_FLAGS", "ACT_FLAGS", "CHANGE_FLAGS", "FLOW_FLAGS")
    counts |= daemon_metric_sets("COUNTS", "ACT_COUNTS", "CHANGE_COUNTS", "FLOW_COUNTS")
    return (
        words("VALUE_FLAGS", browse_cli.VALUE_FLAGS)
        + words("BOOL_FLAGS", browse_cli.BOOL_FLAGS)
        + words("LAUNCH_ONLY", browse_cli.LAUNCH_ONLY)
        + pairs("LAUNCH_HINTS", browse_cli.LAUNCH_HINTS)
        + f"export const COMMAND_OWNS: Readonly<Record<string, readonly string[]>> = {json.dumps(owns)};\n"
        + f"export const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {json.dumps(local)};\n"
        + words("KNOWN_COMMANDS", known_browse_commands())
        + words("LOCAL_AUTH", browse_cli.LOCAL_AUTH)
        + words("EVAL_VALUE_FLAGS", browse_cli.EVAL_VALUE_FLAGS)
        + pairs("ALIASES", ALIASES)
        + words("MUTATING", MUTATING)
        + words("TAKES_OUT", outfile.TAKES_OUT)
        + words("AS_TEXT", outfile.AS_TEXT)
        + words("TASK_COMMANDS", usage.TASK_COMMANDS)
        + words("METRIC_FLAGS", flags)
        + words("METRIC_DURATIONS", command_metrics.DURATIONS)
        + words("METRIC_COUNTS", counts)
        + number("METRIC_MAX_MS", command_metrics.MAX_MS)
        + number("METRIC_MAX_COUNT", command_metrics.MAX_COUNT)
        + text("COMMAND_NAME", telemetry.COMMAND_NAME.pattern)
        + text("STAR_PROMPT", usage.STAR_PROMPT)
        + number("QUEUE_WAIT", limits.QUEUE_WAIT)
        + number("BEHIND_SCRIPT_WAIT", limits.BEHIND_SCRIPT_WAIT)
        + number("COMMAND_LIMIT", limits.COMMAND_LIMIT)
        + number("LIMIT_MARGIN", limits.LIMIT_MARGIN)
        + number("SCRIPT_DEFAULT", limits.SCRIPT_DEFAULT)
        + number("DEFAULT_TIMEOUT_MS", limits.DEFAULT_TIMEOUT_MS)
        + f"export const LONG_COMMANDS: Readonly<Record<string, number>> = {json.dumps(dict(sorted(limits.LONG_COMMANDS.items())))};\n"
    )


TS_HELP_ADDITIONS = (
    ("OVERVIEW", "  click <sel>                Click element (or @ref) [--new-tab]\n",
     "  click <sel>                Click element (or @ref) [--new-tab] [--touch]\n"),
    ("OVERVIEW", "  eval <js>                  Run JavaScript in the page [-b base64] [--stdin] [--timeout 2m]\n",
     "  eval <js>                  Run JavaScript in the page [-b base64] [--stdin] [--timeout 2m] [--isolated]\n"),
    ("OVERVIEW", "             set device|geo|offline|headers|credentials|media\n",
     "             set device|geo|offline|headers|credentials|media|permission\n"),
    ("OVERVIEW", "set device|geo|offline|\nheaders|credentials|media, network route,",
     "set device|geo|offline|\nheaders|credentials|media|permission, network route,"),
    ("OVERVIEW", "(--links <pattern>: every matching link; -s sel)\n",
     "(--links <pattern>: every matching link; -s sel)\n"
     "  links [pattern]            List the session tab's links whose URL contains pattern (read --links … --list)\n"),
    ("OVERVIEW", "Get Info:    get text|html|value|attr <name>|title|url|count|box|styles <sel>\n",
     "Get Info:    get text|html|value|title|url|count|box|styles <sel> | attr <sel> <name> (or -s <sel>)\n"),
    ("OVERVIEW", "             find role <role> <action> --name <name>: exact name first, several matches list refs\n",
     "             find role <role> <action> --name <name>: exact name first, several matches list refs\n"
     "             --nth <n> picks match n of several (from 0)\n"),
    ("get", "ardia browse get text|html|value|attr <name>|title|url|count|box|styles <sel>\n",
     "ardia browse get text|html|value|title|url|count|box|styles <sel> | attr <sel> <name>\n\n"
     "attribute works as attr. The selector can also come as -s <sel> or --selector <sel>.\n"),
    ("screenshot", "Without a path it saves under $TMPDIR/ardia-browse/screenshots.",
     "Without a path it saves under $TMPDIR/ardia-browse/screenshots.\n-s <sel> or --selector <sel> names the element to capture, like [sel]."),
    ("click", "one that enables it in the same batch.",
     "one that enables it in the same batch.\nThe selector can also come as -s <sel> or --selector <sel>."),
    ("fill", "Prints what changed.",
     "Prints what changed. The selector can also come as -s <sel> or --selector <sel>, before the text."),
    ("find", "An element that isn't there yet is waited for up to 1.5 s.",
     "An element that isn't there yet is waited for up to 1.5 s. find role … --nth <n> picks match n of several\n"
     "(from 0, like find nth) and says which; it works only with find role."),
    ("open", "[--capture-console] [--label name]\n", "[--capture-console] [--label name] [--here]\n"),
    ("open", "When the session was using the user's tab (`tab active`), the answer\nnames both: `→ [t4] is this session's tab now …; `tab t3` goes back`.",
     "When the session is using the user's tab (`tab active`), open goes to a new background tab of its own and its\n"
     "first line says so, leaving the user's tab as it was; open --here <url> navigates the picked tab instead.\n"
     "A ref from the page a later open replaced fails as stale and names both pages; `tab new <url>` keeps both."),
    ("click", "[--button left|right|middle] [--humanize]", "[--button left|right|middle] [--touch] [--humanize]"),
    ("click", "one that enables it in the same batch.",
     "one that enables it in the same batch.\n--touch taps instead when the page supports touch (it reports touch points), and clicks otherwise, saying so."),
    ("press", "Modifiers: Control, Alt, Shift, Meta (Meta+a selects all on macOS).",
     "Modifiers: Control, Alt, Shift, Meta. Control or Meta with a selects all, with z undoes and with y or Shift+z redoes;\n"
     "on macOS Meta+c/x/v, Meta and Alt with the arrows, Backspace and Delete also edit as they do in a text field."),
    ("wait", "--fn evaluates in the page's main world, like eval. Timeouts default to 25 s.",
     "--fn evaluates in the page's main world, like eval (--main-world says so; --isolated: in an isolated world).\n"
     "Timeouts default to 25 s."),
    ("eval", "| --stdin [--timeout 2m] [--out <file>]\n", "| --stdin [--timeout 2m] [--out <file>] [--isolated]\n"),
    ("eval", "Runs in the page's main world (the one place, with init scripts and the React hook, that does).",
     "Runs in the page's main world (the one place, with init scripts and the React hook, that does), where the\n"
     "page's own globals are; --main-world says so explicitly. --isolated runs it in an isolated world instead: the\n"
     "same DOM, none of the page's JavaScript, and nothing it defines is visible to the page."),
    ("set", "  | credentials <user> <pass> | media [dark|light|no-preference] [reduced-motion]\n\n",
     "  | credentials <user> <pass> | media [dark|light|no-preference] [reduced-motion]\n"
     "  | permission geolocation|notifications|camera|microphone|clipboard [more …]\n\n"
     "set permission grants those permissions to the tab's site ahead of any prompt (Browser.setPermission, which no\n"
     "released Ardia allows yet: it fails with policy_refused).\n"),
    ("read", "--links <pattern> reads every link on the session's tab whose URL contains the\npattern (* matches anything), in page order; --list only prints those links.",
     "--links <pattern> reads every link whose URL contains the pattern (* matches\nanything), in page order, from each URL you name (opened in a background tab, not read itself), else from the session's\ntab; --list only prints those links."),
)


TS_HELP_COMMANDS = {
    "links": "ardia browse links [pattern] [--limit n]\n\n"
             "Lists the links on the session's tab whose URL contains the pattern (* or none: every link), in page\n"
             "order: read's link listing as one command.",
}


def with_ts_additions(name: str, text: str) -> str:
    for target, old, new in TS_HELP_ADDITIONS:
        if target != name:
            continue
        if text.count(old) != 1:
            raise AssertionError(f"the TypeScript help addition for {name} no longer applies to Python's help: {old!r}")
        text = text.replace(old, new)
    return text


def ts_help() -> str:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli.browse import help as browse_help

    rows = "".join(f"  {json.dumps(name)}: {json.dumps(with_ts_additions(name, text), ensure_ascii=False)},\n"
                   for name, text in {**browse_help.COMMANDS, **TS_HELP_COMMANDS}.items())
    return (f"export const OVERVIEW = {json.dumps(with_ts_additions('OVERVIEW', browse_help.OVERVIEW), ensure_ascii=False)};\n"
            f"export const COMMANDS: Readonly<Record<string, string>> = {{\n{rows}}};\n")


class TsBrowseTables(unittest.TestCase):
    def test_help_is_python_help_plus_the_typescript_additions(self):
        self.assertEqual(HELP.read_text(), ts_help(), "ts/src/browse/help-text.ts is stale; regenerate it: "
                         "python -c 'from tests.test_ts_browse_tables import ts_help; print(ts_help(), end=\"\")' > ts/src/browse/help-text.ts")

    def test_tables_match_python(self):
        self.assertEqual(TABLES.read_text(), ts_tables(), f"ts/src/browse/tables.ts is stale; regenerate it: {REGENERATE}")


if __name__ == "__main__":
    unittest.main()
