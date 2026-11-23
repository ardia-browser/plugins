import argparse
import hashlib
import importlib
import json
import sys
from pathlib import Path

CLI = Path(__file__).resolve().parents[2]
OUT = CLI / "ts" / "src" / "browse" / "js"
MANIFEST = OUT / "manifest.json"
CONSTANTS = {
    "js": ["LIBRARY"],
    "actions": ["DISABLED_STATE", "CELL_OF", "CELL_START", "CELL_INNER", "CELL_EDITOR", "CELL_EDITOR_STATE", "CELL_FIND", "CELL_NOW",
                "SETTLED_FRAMES", "CELL_REVEAL", "LIST_BEFORE", "LIST_AFTER", "FOCUSED_HERE", "CLOSE_CONTROL", "CENTER", "VISIBLE_LABEL",
                "VISIBLE_CONTENT", "HOLDS_TEXT", "SCROLL_LOCK", "DOM_CLICK", "REPLACEMENT"],
    "audit": ["RUN"],
    "changes": ["TEXT_JS"],
    "commands": ["PAGE_TEXT_MARK", "FETCH_BYTES", "READ_SCOPED"],
    "fields": ["SET_VALUE"],
    "flowlog": ["FIELD"],
    "flowrun": ["FETCH"],
    "page": ["FOCUS_INSIDE"],
    "pagedata": ["SCRIPTS"],
    "pdftext": ["JXA", "FETCH"],
    "react": ["HOOK"],
    "readpages": ["MAIN_LIST", "LINKS", "EXTRACT", "SETTLE_PROBE", "SCROLL_STEP"],
    "script": ["CONTROLLER", "WORKER"],
    "snapshot": ["FIELD_VALUE"],
}


def file_name(module: str, name: str) -> str:
    return f"{module}.{name.lower().replace('_', '-')}.js.txt"


def ts_name(module: str, name: str) -> str:
    return name if module == "js" else f"{module.upper()}_{name}"


def collect() -> dict[str, tuple[str, str, bytes]]:
    sys.path.insert(0, str(CLI))
    found = {}
    for module, names in CONSTANTS.items():
        loaded = importlib.import_module(f"ardia_cli.browse.{module}")
        for name in names:
            value = getattr(loaded, name)
            if not isinstance(value, str):
                raise SystemExit(f"ardia_cli.browse.{module}.{name} isn't a string")
            found[file_name(module, name)] = (module, name, value.encode("utf-8", "surrogatepass"))
    return found


def index_source(found: dict[str, tuple[str, str, bytes]]) -> str:
    lines = []
    for file, (module, name, _) in found.items():
        lines.append(f'import {ts_name(module, name)} from "./{file}" with {{ type: "text" }};')
    lines.append("")
    lines.append("export {")
    lines.extend(f"  {ts_name(module, name)}," for module, name, _ in found.values())
    lines.append("};")
    return "\n".join(lines) + "\n"


def manifest_source(found: dict[str, tuple[str, str, bytes]]) -> str:
    entries = {file: {"python": f"ardia_cli.browse.{module}.{name}", "sha256": hashlib.sha256(data).hexdigest()}
               for file, (module, name, data) in found.items()}
    return json.dumps(entries, indent=2) + "\n"


def wanted(found: dict[str, tuple[str, str, bytes]]) -> dict[Path, bytes]:
    files = {OUT / file: data for file, (_, _, data) in found.items()}
    files[OUT / "index.ts"] = index_source(found).encode()
    files[MANIFEST] = manifest_source(found).encode()
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description="Copies the browse daemon's page JavaScript out of the Python modules into "
                                     "ts/src/browse/js, byte for byte, with a sha256 manifest. --check compares instead of writing.")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    found = collect()
    files = wanted(found)
    extra = sorted(path.name for path in OUT.glob("*.js.txt") if path not in files) if OUT.exists() else []
    if args.check:
        stale = [path.name for path, data in files.items() if not path.exists() or path.read_bytes() != data]
        for name in stale + extra:
            print(f"extract-js: {name} differs from the Python source", file=sys.stderr)
        if stale or extra:
            print("extract-js: run plugins/cli/ts/scripts/extract-js.py", file=sys.stderr)
            return 1
        print(f"extract-js: {len(found)} constants match")
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    for name in extra:
        (OUT / name).unlink()
    for path, data in files.items():
        path.write_bytes(data)
    print(f"extract-js: wrote {len(found)} constants")
    return 0


if __name__ == "__main__":
    sys.exit(main())
