import json
import re
from functools import cache
from pathlib import Path

SCHEMA = Path(__file__).with_name("protocol.schema.json")
TYPES = {
    "object": lambda value: isinstance(value, dict),
    "array": lambda value: isinstance(value, list),
    "string": lambda value: isinstance(value, str),
    "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
    "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool),
    "boolean": lambda value: isinstance(value, bool),
    "null": lambda value: value is None,
}


@cache
def schema() -> dict:
    return json.loads(SCHEMA.read_text())


def resolve(node: dict) -> dict:
    while "$ref" in node:
        node = schema()["$defs"][node["$ref"].removeprefix("#/$defs/")]
    return node


def errors(value, node: dict, where: str = "") -> list[str]:
    node = resolve(node)
    found: list[str] = []
    if "type" in node:
        kinds = node["type"] if isinstance(node["type"], list) else [node["type"]]
        if not any(TYPES[kind](value) for kind in kinds):
            return [f"{where or '/'}: {json.dumps(value)[:80]} isn't {' or '.join(kinds)}"]
    if "const" in node and value != node["const"]:
        found.append(f"{where or '/'}: must be {json.dumps(node['const'])}")
    if isinstance(value, str):
        if "pattern" in node and not re.search(node["pattern"], value):
            found.append(f"{where or '/'}: {value[:80]!r} doesn't match {node['pattern']}")
        if len(value) < node.get("minLength", 0):
            found.append(f"{where or '/'}: too short")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in node and value < node["minimum"]:
            found.append(f"{where or '/'}: below {node['minimum']}")
        if "maximum" in node and value > node["maximum"]:
            found.append(f"{where or '/'}: above {node['maximum']}")
    if isinstance(value, dict):
        for key in node.get("required", []):
            if key not in value:
                found.append(f"{where}/{key}: missing")
        properties = node.get("properties", {})
        extra = node.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                found += errors(item, properties[key], f"{where}/{key}")
            elif isinstance(extra, dict):
                found += errors(item, extra, f"{where}/{key}")
            elif extra is False:
                found.append(f"{where}/{key}: not allowed")
    if isinstance(value, list) and "items" in node:
        for index, item in enumerate(value):
            found += errors(item, node["items"], f"{where}[{index}]")
    if "anyOf" in node and not any(not errors(value, option, where) for option in node["anyOf"]):
        found.append(f"{where or '/'}: matches none of its forms")
    return found


def check(kind: str, value) -> list[str]:
    return [f"{kind} {line}" for line in errors(value, schema()["$defs"][kind])]


def violations(result) -> list[str]:
    found = []
    for index, step in enumerate(result.steps):
        for item in step.get("answers") or []:
            if "wire" in item:
                found += [f"step {index}: {line}" for line in check("request", item["wire"])]
            if isinstance(item.get("answer"), dict):
                found += [f"step {index}: {line}" for line in check("answer", item["answer"])]
    config = result.root / "home" / "spawn-config.jsonl"
    if config.exists():
        for line in config.read_text().splitlines():
            found += check("config", json.loads(line))
    return found
