import { type Value } from "../../src/json.ts";
import { pageSite, parseArgs, siteOf } from "../../src/notes.ts";
import { commandLine, originOf } from "../../src/browse/auth/vault.ts";
import { plainParams } from "../../src/browse/cdp/params.ts";
import { cdpParams } from "../../src/browse/commands/cdp.ts";
import { quoteSelectorLiterals } from "../../src/browse/commands/pagejs.ts";
import { baseDomain, embeddedJson, findArguments, keptHeaders, type Step } from "../../src/browse/flows/flowlog.ts";
import { buildFlow, drift, fillUrl, maskedPart, parseParams, signature, siteOf as flowSite, slug, templateUrl, validate } from "../../src/browse/flows/flows.ts";
import { renderJson } from "../../src/browse/script/render.ts";
import { keptPreview, pageWorldHint, splitCommandLine, stateSummary, tail, workerSource } from "../../src/browse/script/script.ts";
import { parseTimeout } from "../../src/browse/script/timeout.ts";
import { parseText } from "../../src/json.ts";
import { float, num, optionalText, text, texts, toValue } from "./values.ts";

function plain(value: Value | undefined): any {
  return plainParams(value ?? null);
}

function pairs(value: Value | undefined): [string, string][] {
  return (Array.isArray(value) ? value : []).map((pair) => texts(pair) as [string, string]);
}

function strings(value: Value | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (value instanceof Map) for (const [key, item] of value) out[key] = text(item);
  return out;
}

export const D7_FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  "d7.cdp_params": (raw, given, stdin) => cdpParams(optionalText(raw), texts(given), optionalText(stdin)),
  "d7.build_flow": (name, steps, given, output, description, secrets) => {
    const [flow, report] = buildFlow(text(name), plain(steps) as Step[], strings(given), optionalText(output), optionalText(description), "9.9.9", texts(secrets));
    delete flow["createdAt"];
    return [toValue(flow), toValue(report)];
  },
  "d7.validate": (flow, site, name) => toValue(validate(plain(flow), optionalText(site), optionalText(name))),
  "d7.signature": (value) => toValue(signature(value)),
  "d7.drift": (recorded, value) => drift(plain(recorded), value),
  "d7.template_url": (url, values) => templateUrl(text(url), pairs(values)),
  "d7.fill_url": (url, values) => fillUrl(text(url), strings(values)),
  "d7.masked_part": (part, typed, secrets, values) => maskedPart(text(part), plain(typed), texts(secrets), pairs(values)),
  "d7.flow_site": (url) => flowSite(text(url)),
  "d7.slug": (value) => slug(text(value)),
  "d7.base_domain": (host) => baseDomain(text(host)),
  "d7.embedded_json": (html) => embeddedJson(text(html)).map(([spec, value, size]): Value => [toValue(spec), value, BigInt(size)]),
  "d7.kept_headers": (headers) => {
    const [kept, stripped] = keptHeaders(plain(headers));
    return [toValue(kept), stripped];
  },
  "d7.find_arguments": (args, name) => {
    const [locator, rest, wanted] = findArguments(texts(args), optionalText(name));
    return [locator, rest, wanted];
  },
  "d7.notes_site": (value) => siteOf(text(value)),
  "d7.page_site": (url) => pageSite(optionalText(url)),
  "d7.notes_args": (args) => {
    const request = parseArgs(texts(args));
    return [request.action, request.site, request.text];
  },
  "d7.worker_source": (source, state) => {
    const [code, offset] = workerSource(text(source), text(state));
    return [code, BigInt(offset)];
  },
  "d7.split_command_line": (argv) => splitCommandLine(texts(argv)),
  "d7.tail": (lines, limit) => tail(texts(lines), num(limit)),
  "d7.page_world_hint": (message, command) => pageWorldHint(text(message), plain(command)),
  "d7.state_summary": (json) => stateSummary(parseText(text(json)) as Value),
  "d7.kept_preview": (state) => keptPreview(plain(state)),
  "d7.render_json": (value) => renderJson(value),
  "d7.parse_timeout": (value) => float(parseTimeout(optionalText(value))),
  "d7.quote_selectors": (script) => {
    const [fixed, quoted] = quoteSelectorLiterals(text(script));
    return [fixed, quoted];
  },
  "d7.command_line": (words) => commandLine(texts(words)),
  "d7.origin_of": (url) => originOf(text(url)),
  "d7.parse_params": (values) => toValue(parseParams(Array.isArray(values) ? texts(values) : null)),
};
