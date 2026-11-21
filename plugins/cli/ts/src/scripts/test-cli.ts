import type { ArgValue } from "../argparse.ts";
import { parseArgs } from "../argparse-env.ts";
import { Cancelled } from "../browse/cdp/cancel.ts";
import { EndpointError, resolve } from "../browse/endpoint.ts";
import { dataRoot, interrupted } from "../control.ts";
import { interruptsIgnored } from "../libc.ts";
import { dumps } from "../json.ts";
import { inert, toStderr } from "../printable.ts";
import { redact } from "../redact.ts";
import { type ScriptsArgs, testOptions } from "./args.ts";
import { build } from "./build.ts";
import type { Say } from "./output.ts";
import { formatReport, reportJson, runTest } from "./test-run.ts";
import { defaultUrl, ScriptError, urlRuns } from "./userscript.ts";

type Stop = "interrupted" | "terminated";

function complain(text: string): void {
  toStderr(inert(`${redact(text)}\n`));
}

function say(out: Say, text: string): void {
  out.say(redact(text));
}

function text(value: ArgValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function flagNames(flags: readonly string[]): string[] {
  return flags.filter((token) => token.startsWith("--")).map((token) => token.split("=", 1)[0] as string);
}

function reportBuildError(out: Say, json: boolean, file: string, message: string): number {
  if (json) {
    const shown = new Map<string, string | boolean>([
      ["ok", false],
      ["ran", false],
      ["script", file],
      ["error", message],
    ]);
    say(out, dumps(shown, "indented", false));
  } else complain(`ardia scripts: ${message}`);
  return 1;
}

function stopOn(controller: AbortController, stopped: { why: Stop | null }, signals: readonly NodeJS.Signals[], why: Stop): () => void {
  const handler = () => {
    stopped.why ??= why;
    controller.abort();
  };
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}

export async function runTestCommand(args: ScriptsArgs, out: Say): Promise<number> {
  const hoisted = args.hoisted ?? [];
  const options = new Set(testOptions());
  for (const name of flagNames(hoisted)) {
    if (!options.has(name)) {
      complain(`ardia: scripts test doesn't take ${name}`);
      return 2;
    }
  }
  const parsed = parseArgs("ardia", ["scripts", "test", ...hoisted, ...(args.rest ?? [])]);
  if (!parsed.ok) {
    if (parsed.stdout) say(out, parsed.stdout.replace(/\n$/, ""));
    if (parsed.stderr) complain(parsed.stderr.replace(/\n$/, ""));
    return parsed.status;
  }
  if (parsed.stderr) complain(parsed.stderr.replace(/\n$/, ""));
  const values = parsed.values;
  const file = text(values.get("file")) as string;
  const json = values.get("json") === true;
  const dataDir = text(values.get("data_dir"));
  const wait = Number(values.get("wait"));
  let built;
  try {
    built = await build(file, true, [dataRoot(dataDir ?? undefined)], interrupted);
  } catch (error) {
    if (!(error instanceof ScriptError)) throw error;
    return reportBuildError(out, json, file, error.message);
  }
  const url = text(values.get("url")) || defaultUrl(built.meta);
  if (!url) return reportBuildError(out, json, file, "no @match gives a concrete page to open; pass --url URL");
  if (wait < 0) return reportBuildError(out, json, file, "--wait can't be negative");
  if (!urlRuns(built.meta, url)) built.meta.warnings.push(`${url} doesn't match the script's @match/@include rules, so it won't run there`);
  const controller = new AbortController();
  const stopped: { why: Stop | null } = { why: null };
  const releaseInterrupt = interruptsIgnored() ? () => {} : stopOn(controller, stopped, ["SIGINT"], "interrupted");
  if (interrupted()) {
    stopped.why = "interrupted";
    controller.abort();
  }
  let report;
  try {
    const endpoint = await resolve({ ws: values.get("ws"), port: values.get("port"), data_dir: dataDir }, controller.signal);
    const releaseTerm = stopOn(controller, stopped, ["SIGTERM", "SIGHUP"], "terminated");
    try {
      report = await runTest(built, url, endpoint, { expect: text(values.get("expect")), wait, screenshot: text(values.get("screenshot")), keep: values.get("keep") === true }, controller.signal);
    } finally {
      releaseTerm();
    }
  } catch (error) {
    if (error instanceof EndpointError) {
      complain(`ardia: ${error.message}`);
      return 2;
    }
    if (error instanceof Cancelled) {
      complain(`ardia scripts test: ${stopped.why ?? "interrupted"}`);
      return stopped.why === "terminated" ? 143 : 130;
    }
    throw error;
  } finally {
    releaseInterrupt();
  }
  say(out, json ? reportJson(report) : formatReport(report));
  return report.ok ? 0 : 1;
}
