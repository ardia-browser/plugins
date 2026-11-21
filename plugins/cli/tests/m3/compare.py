import json

LIMIT = 40


def short(value, width: int = 400) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= width else text[:width] + f"… ({len(text)} chars)"


def diff(a, b, path: str = "", out: list | None = None) -> list[str]:
    out = [] if out is None else out
    if len(out) >= LIMIT:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b), key=str):
            if key not in a:
                out.append(f"{path}/{key}: only in B: {short(b[key])}")
            elif key not in b:
                out.append(f"{path}/{key}: only in A: {short(a[key])}")
            else:
                diff(a[key], b[key], f"{path}/{key}", out)
        return out
    if isinstance(a, list) and isinstance(b, list):
        for index in range(max(len(a), len(b))):
            if index >= len(a):
                out.append(f"{path}[{index}]: only in B: {short(b[index])}")
            elif index >= len(b):
                out.append(f"{path}[{index}]: only in A: {short(a[index])}")
            else:
                diff(a[index], b[index], f"{path}[{index}]", out)
        return out
    if a != b:
        if isinstance(a, str) and isinstance(b, str) and "\n" in a + b:
            import difflib

            lines = list(difflib.unified_diff(a.splitlines(), b.splitlines(), "A", "B", lineterm="", n=1))
            out.append(f"{path}:\n    " + "\n    ".join(lines[:30]))
        else:
            out.append(f"{path}: A {short(a)} | B {short(b)}")
    return out


STRICT = ("answers", "requests", "sources", "files")
LIVE = ("answers", "request_sets", "sources", "files")


def compared(a: dict, b: dict, parts=STRICT) -> list[str]:
    found = []
    for part in parts:
        found += diff(a.get(part), b.get(part), part)
    return found
