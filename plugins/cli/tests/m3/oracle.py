import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ardia_cli.browse.errors import BrowseError
from oracle_fns import FUNCTIONS

UNWORDED = {"UnicodeEncodeError", "UnicodeDecodeError", "RecursionError"}


def failure(error: BaseException) -> dict:
    kind = type(error).__name__
    out: dict = {"type": kind}
    if isinstance(error, BrowseError):
        out.update(message=error.message, code=error.code, data=error.data, exit=error.exit_code)
    elif kind not in UNWORDED:
        out["message"] = str(error)
    return out


def answer(case: dict) -> dict:
    try:
        return {"ok": FUNCTIONS[case["fn"]](*case["args"])}
    except Exception as error:
        return {"raise": failure(error)}


def main() -> int:
    sys.setrecursionlimit(10000)
    out = sys.stdout
    for line in sys.stdin:
        if line.strip():
            out.write(json.dumps(answer(json.loads(line)), ensure_ascii=True, separators=(",", ":")) + "\n")
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
