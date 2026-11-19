import { Float, type Value } from "../../src/json.ts";
import * as errors from "../../src/browse/daemon-errors.ts";
import { normalize } from "../../src/browse/fields.ts";
import * as flowurl from "../../src/browse/flowurl.ts";
import { commandLimit, givenTimeout, queueWait, secondsOf } from "../../src/browse/limits.ts";
import { clean, Metrics, recordRendered } from "../../src/browse/metrics.ts";
import * as shape from "../../src/browse/shape.ts";
import { addSecret, clearSecrets, redact, RedactingStream, unsafeTail } from "../../src/redact.ts";
import { isIPv4Address, isIPv6Address } from "../../src/pylib/ipaddress.ts";
import { formatG, roundHalfEven, roundTo } from "../../src/pylib/format.ts";
import { compareText, PyException, pyFloat, pyInt, pyLen, reprText } from "../../src/pylib/str.ts";
import { casefold } from "../../src/pylib/unicode.ts";
import { quote, quotePlus, unquote, unquotePlus, urlsplit } from "../../src/pylib/urllib.ts";
import { bool, float, num, optionalFloat, optionalText, text, texts, toValue } from "./values.ts";
import { P2_FUNCTIONS } from "./oracle-fns-p2.ts";

type Fn = (...args: Value[]) => Value;

function setSecrets(secrets: Value): void {
  clearSecrets();
  for (const secret of texts(secrets)) addSecret(secret);
}

function errorFields(error: errors.BrowseError): Map<string, Value> {
  return new Map<string, Value>([
    ["type", error.constructor.name],
    ["message", error.text],
    ["code", error.code ?? null],
    ["data", error.data === undefined || error.data === null ? null : toValue(error.data)],
    ["exit", BigInt(error.exitCode)],
  ]);
}

function makeError(kind: string, args: Value[]): errors.BrowseError {
  const at = (index: number) => optionalText(args[index]);
  switch (kind) {
    case "Gated":
      return new errors.Gated(text(args[0]), at(1), at(2), at(3));
    case "GatedDuring":
      return new errors.Gated(text(args[0]), at(1), at(2), at(3)).during(at(4), at(5));
    case "StaleRef":
      return new errors.StaleRef(text(args[0]), text(args[1]));
    case "CdpError":
      return new errors.CdpError(text(args[0]), text(args[1]));
    case "CdpTimeout":
      return new errors.CdpTimeout(text(args[0]), num(args[1]));
    case "PageBusy":
      return new errors.PageBusy(text(args[0]), num(args[1]), text(args[2]));
    case "NotFocusable":
      return new errors.NotFocusable(text(args[0]));
    case "OutcomeUnknown":
      return new errors.OutcomeUnknown(text(args[0]), text(args[1]));
    case "ConnectionLost":
      return args.length ? new errors.ConnectionLost(text(args[0])) : new errors.ConnectionLost();
    case "Usage":
      return new errors.Usage(text(args[0]));
    default:
      return new errors.Unreachable(text(args[0]));
  }
}

function metricsInput(values: Value): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!(values instanceof Map)) return out;
  for (const [key, value] of values) out.set(key, typeof value === "bigint" ? Number(value) : value instanceof Float ? value.value : value);
  return out;
}

function metricOutput(values: ReadonlyMap<string, unknown>, floats: ReadonlySet<string>): Map<string, Value> {
  return new Map([...values].map(([key, value]): [string, Value] => [key, typeof value === "number" ? (floats.has(key) ? new Float(value) : BigInt(Math.trunc(value))) : toValue(value)]));
}

function urlFields(url: flowurl.Url): Value {
  return new Map<string, Value>([
    ["scheme", url.scheme], ["host", url.host], ["port", BigInt(url.port)], ["path", url.path], ["query", url.query], ["literal", url.literal],
    ["origin", url.origin], ["text", url.text],
  ]);
}

function pyRound(value: number): bigint {
  if (Number.isNaN(value)) throw new PyException("ValueError", "cannot convert float NaN to integer");
  if (!Number.isFinite(value)) throw new PyException("OverflowError", "cannot convert float infinity to integer");
  return BigInt(roundHalfEven(value));
}

export const FUNCTIONS: Record<string, Fn> = {
  "limits.seconds_of": (value) => optionalFloat(secondsOf(optionalText(value))),
  "limits.given_timeout": (argv) => optionalFloat(givenTimeout(texts(argv))),
  "limits.command_limit": (name, argv, timeout) => float(commandLimit(text(name), texts(argv), num(timeout))),
  "limits.queue_wait": (name, argv, base, patient) => float(queueWait(text(name), texts(argv), num(base), bool(patient))),
  "errors.make": (kind, args) => {
    const made = makeError(text(kind), args as Value[]);
    const out = errorFields(made);
    if (made instanceof errors.Gated) {
      out.set("refusal", made.refusal);
      out.set("reason", made.reason);
    }
    return out;
  },
  "errors.refusal_reason": (value, method) => errors.refusalReason(text(value), text(method)),
  "redact.redact": (secrets, value) => {
    setSecrets(secrets);
    return redact(text(value));
  },
  "redact.unsafe_tail": (secrets, value) => {
    setSecrets(secrets);
    const body = text(value);
    return BigInt(pyLen(body.slice(body.length - unsafeTail(body))));
  },
  "redact.stream": (secrets, chunks) => {
    setSecrets(secrets);
    const written: Value[] = [];
    const stream = new RedactingStream({ write: (part) => written.push(part), flush: () => written.push(null) });
    const returns = texts(chunks).map((chunk) => BigInt(stream.write(chunk)));
    stream.drain();
    return new Map<string, Value>([["written", written], ["returns", returns]]);
  },
  "metrics.clean": (values) => metricOutput(clean(metricsInput(values)), new Set()),
  "metrics.rendered": (name, data, batch, code, out) => {
    const metrics = new Metrics(text(name), false, false);
    recordRendered(metrics, text(name), { data, batch }, code === false ? null : { code: code as string | null }, text(out));
    return new Map<string, Value>([["values", metricOutput(metrics.values, new Set(["cdp_ms_total"]))], ["error_code", metrics.errorCode]]);
  },
  "shape.parse": (fields, where, limit) => {
    const parsed = shape.parseShape(optionalText(fields), where === null ? null : texts(where), limit as string | bigint | null);
    return new Map<string, Value>([["fields", parsed.fields], ["where", parsed.where], ["limit", parsed.limit], ["empty", parsed.empty]]);
  },
  "shape.apply": (body, fields, where, limit, always, path) =>
    shape.apply(body, shape.parseShape(optionalText(fields), where === null ? null : texts(where), limit as string | bigint | null), bool(always), optionalText(path)),
  "shape.lookup": (value, path) => {
    const found = shape.lookup(value, text(path));
    return found === shape.MISSING ? new Map<string, Value>([["missing", true]]) : new Map<string, Value>([["value", found]]);
  },
  "shape.main_list": (body) => shape.mainList(body),
  "shape.item_fields": (items) => shape.itemFields(items as Value[]),
  "flowurl.parse": (url) => urlFields(flowurl.parse(url)),
  "flowurl.checked": (url, secrets) => urlFields(flowurl.checked(text(url), texts(secrets))),
  "flowurl.credential_key": (key) => flowurl.credentialKey(text(key)),
  "flowurl.literal_ok": (value, segment) => flowurl.literalOk(text(value), bool(segment)),
  "flowurl.encodings": (secret) => [...flowurl.encodings(text(secret))].sort(compareText),
  "flowurl.carries": (value, secret) => flowurl.carries(optionalText(value), text(secret)),
  "flowurl.query_pairs": (query) => flowurl.queryPairs(text(query)),
  "flowurl.host_label": (url) => flowurl.hostLabel(text(url)),
  "flowurl.mask": (url, secrets) => flowurl.mask(text(url), texts(secrets)),
  "fields.normalize": (kind, value) => normalize(text(kind), text(value)),
  "urllib.urlsplit": (url) => {
    const parts = urlsplit(text(url));
    return [parts.scheme, parts.netloc, parts.path, parts.query, parts.fragment];
  },
  "urllib.unquote": (value) => unquote(text(value)),
  "urllib.unquote_plus": (value) => unquotePlus(text(value)),
  "urllib.quote": (value, safe) => quote(text(value), text(safe)),
  "urllib.quote_plus": (value, safe) => quotePlus(text(value), text(safe)),
  "ipaddress.kind": (value) => (isIPv4Address(text(value)) ? "IPv4Address" : isIPv6Address(text(value)) ? "IPv6Address" : "none"),
  "py.repr": (value) => reprText(text(value)),
  "py.int": (value) => pyInt(text(value)),
  "py.float": (value) => new Float(pyFloat(text(value))),
  "py.casefold": (value) => casefold(text(value)),
  "py.format_g": (value, precision) => formatG(num(value), num(precision)),
  "py.round": (value) => pyRound(num(value)),
  "py.round_to": (value, digits) => new Float(roundTo(num(value), num(digits))),
  "py.len": (value) => BigInt(pyLen(text(value))),
  ...P2_FUNCTIONS,
};
