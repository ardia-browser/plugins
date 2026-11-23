import copy
import json

from ardia_cli import notes
from ardia_cli.browse import flowlog, flows, script, vault
from ardia_cli.browse.commands import find_arguments, quote_selector_literals


def cdp_params(raw, pairs, stdin):
    from ardia_cli.browse.cli import cdp_params as build

    return build(raw, pairs, stdin)


def build_flow(name, steps, given, output, description, secrets):
    flow, report = flows.build_flow(name, copy.deepcopy(steps), given, output, description, "9.9.9", secrets)
    flow.pop("createdAt", None)
    return [flow, report]


def embedded(html):
    return [[spec, value, size] for spec, value, size in flowlog.embedded_json(html)]


def parse_notes(args):
    request = notes.parse_args(args)
    return [request.action, request.site, request.text]


def command_line(words):
    return " ".join(vault.quote(word) if index else word for index, word in enumerate(words)) + "\n"


def state_summary(text):
    return script.state_summary(json.loads(text))


def register(oracle):
    oracle("d7.cdp_params")(cdp_params)
    oracle("d7.build_flow")(build_flow)
    oracle("d7.validate")(lambda flow, site, name: flows.validate(flow, site, name))
    oracle("d7.signature")(lambda value: flows.signature(value))
    oracle("d7.drift")(lambda recorded, value: flows.drift(recorded, value))
    oracle("d7.template_url")(lambda url, values: flows.template_url(url, [tuple(pair) for pair in values]))
    oracle("d7.fill_url")(flows.fill_url)
    oracle("d7.masked_part")(lambda part, typed, secrets, values: flows.masked_part(part, typed, secrets, [tuple(pair) for pair in values]))
    oracle("d7.flow_site")(flows.site_of)
    oracle("d7.slug")(flows.slug)
    oracle("d7.base_domain")(flowlog.base_domain)
    oracle("d7.embedded_json")(embedded)
    oracle("d7.kept_headers")(lambda headers: list(flowlog.kept_headers(headers)))
    oracle("d7.find_arguments")(lambda args, name: list(find_arguments(list(args), name)))
    oracle("d7.notes_site")(notes.site_of)
    oracle("d7.page_site")(notes.page_site)
    oracle("d7.notes_args")(parse_notes)
    oracle("d7.worker_source")(lambda source, state: list(script.worker_source(source, state)))
    oracle("d7.split_command_line")(script.split_command_line)
    oracle("d7.tail")(lambda lines, limit: script.tail(lines, limit))
    oracle("d7.page_world_hint")(script.page_world_hint)
    oracle("d7.state_summary")(state_summary)
    oracle("d7.kept_preview")(script.kept_preview)
    oracle("d7.render_json")(script.render_json)
    oracle("d7.parse_timeout")(script.parse_timeout)
    oracle("d7.quote_selectors")(lambda text: list(quote_selector_literals(text)))
    oracle("d7.command_line")(command_line)
    oracle("d7.origin_of")(vault.origin_of)
    oracle("d7.parse_params")(flows.parse_params)
