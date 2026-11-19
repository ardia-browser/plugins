import ipaddress
import types
import urllib.parse

from ardia_cli import command_metrics, redact
from ardia_cli.browse import errors, fields, flowurl, limits, shape

FUNCTIONS: dict = {}


def oracle(name: str):
    def register(function):
        FUNCTIONS[name] = function
        return function

    return register


def error_fields(error: errors.BrowseError) -> dict:
    return {"type": type(error).__name__, "message": error.message, "code": error.code, "data": error.data, "exit": error.exit_code}


oracle("limits.seconds_of")(limits.seconds_of)
oracle("limits.given_timeout")(limits.given_timeout)
oracle("limits.command_limit")(limits.command_limit)
oracle("limits.queue_wait")(lambda name, argv, base, patient: limits.queue_wait(name, argv, base, patient))


@oracle("errors.make")
def errors_make(kind: str, args: list):
    made = {
        "Gated": lambda: errors.Gated(*args),
        "GatedDuring": lambda: errors.Gated(*args[:4]).during(*args[4:]),
        "StaleRef": lambda: errors.StaleRef(*args),
        "CdpError": lambda: errors.CdpError(*args),
        "CdpTimeout": lambda: errors.CdpTimeout(*args),
        "PageBusy": lambda: errors.PageBusy(*args),
        "NotFocusable": lambda: errors.NotFocusable(*args),
        "OutcomeUnknown": lambda: errors.OutcomeUnknown(*args),
        "ConnectionLost": lambda: errors.ConnectionLost(*args),
        "Usage": lambda: errors.Usage(*args),
        "Unreachable": lambda: errors.Unreachable(*args),
    }[kind]()
    out = error_fields(made)
    if isinstance(made, errors.Gated):
        out["refusal"] = made.refusal
        out["reason"] = made.reason
    return out


oracle("errors.refusal_reason")(errors.refusal_reason)


def secrets_set(secrets: list) -> None:
    redact._secrets.clear()
    for secret in secrets:
        redact.add_secret(secret)


@oracle("redact.redact")
def redact_text(secrets: list, text: str) -> str:
    secrets_set(secrets)
    return redact.redact(text)


@oracle("redact.unsafe_tail")
def redact_tail(secrets: list, text: str) -> int:
    secrets_set(secrets)
    return redact._unsafe_tail(text)


@oracle("redact.stream")
def redact_stream(secrets: list, chunks: list) -> dict:
    secrets_set(secrets)
    written: list = []
    sink = types.SimpleNamespace(write=written.append, flush=lambda: written.append(None))
    stream = redact.RedactingStream(sink)
    returns = [stream.write(chunk) for chunk in chunks]
    stream.drain()
    return {"written": list(written), "returns": returns}


@oracle("metrics.clean")
def metrics_clean(values):
    return command_metrics.clean(values)


@oracle("metrics.rendered")
def metrics_rendered(name: str, data, batch, code, out: str) -> dict:
    metrics = command_metrics.Metrics(name, False, False)
    token = command_metrics.current.set(metrics)
    try:
        result = types.SimpleNamespace(data=data, batch=batch)
        error = types.SimpleNamespace(code=code) if code is not False else None
        command_metrics.rendered(name, result, error, out)
    finally:
        command_metrics.current.reset(token)
    return {"values": metrics.values, "error_code": metrics.error_code}


def shape_fields(parsed: shape.Shape) -> dict:
    return {"fields": parsed.fields, "where": parsed.where, "limit": parsed.limit, "empty": parsed.empty}


oracle("shape.parse")(lambda fields_, where, limit: shape_fields(shape.parse_shape(fields_, where, limit)))
oracle("shape.apply")(lambda body, fields_, where, limit, always, path: shape.apply(body, shape.parse_shape(fields_, where, limit), always, path))


@oracle("shape.lookup")
def shape_lookup(value, path: str):
    found = shape.lookup(value, path)
    return {"missing": True} if found is shape.MISSING else {"value": found}


oracle("shape.main_list")(shape.main_list)
oracle("shape.item_fields")(shape.item_fields)


def url_fields(url: flowurl.Url) -> dict:
    return {"scheme": url.scheme, "host": url.host, "port": url.port, "path": url.path, "query": url.query, "literal": url.literal,
            "origin": url.origin, "text": url.text}


oracle("flowurl.parse")(lambda url: url_fields(flowurl.parse(url)))
oracle("flowurl.checked")(lambda url, secrets: url_fields(flowurl.checked(url, secrets)))
oracle("flowurl.credential_key")(flowurl.credential_key)
oracle("flowurl.literal_ok")(flowurl.literal_ok)
oracle("flowurl.encodings")(lambda secret: sorted(flowurl.encodings(secret)))
oracle("flowurl.carries")(flowurl.carries)
oracle("flowurl.query_pairs")(flowurl.query_pairs)
oracle("flowurl.host_label")(flowurl.host_label)
oracle("flowurl.mask")(flowurl.mask)
oracle("fields.normalize")(fields.normalize)

oracle("urllib.urlsplit")(lambda url: list(urllib.parse.urlsplit(url)))
oracle("urllib.unquote")(urllib.parse.unquote)
oracle("urllib.unquote_plus")(urllib.parse.unquote_plus)
oracle("urllib.quote")(urllib.parse.quote)
oracle("urllib.quote_plus")(urllib.parse.quote_plus)


@oracle("ipaddress.kind")
def ip_kind(text: str) -> str:
    for kind in (ipaddress.IPv4Address, ipaddress.IPv6Address):
        try:
            kind(text)
            return kind.__name__
        except ValueError:
            pass
    return "none"


oracle("py.repr")(repr)
oracle("py.int")(int)
oracle("py.float")(float)
oracle("py.casefold")(str.casefold)
oracle("py.format_g")(lambda value, precision: format(value, f".{precision}g"))
oracle("py.round")(round)
oracle("py.round_to")(round)
oracle("py.len")(len)
