import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { loadCases, type Case } from "./cases.ts";
import type { Field } from "./compare.ts";
import { runEngineDetached } from "./detached.ts";
import { clone, dumps, isObject, type Py, type PyObject } from "./pyjson.ts";
import { passed, programPath, report } from "./run.ts";

type Tamper = { name: string; field: Field; base: (cases: Case[]) => Case | undefined; change: (expected: PyObject) => void };

const byId = (id: string) => (cases: Case[]) => cases.find((each) => each.id === id);
const firstWith = (test: (expected: PyObject) => boolean) => (cases: Case[]) =>
  [...cases].sort((left, right) => left.id.localeCompare(right.id)).find((each) => each.expected !== undefined && each.expectedLinux === undefined && test(each.expected));
const list = (value: Py | undefined): Py[] => (Array.isArray(value) ? value : []);
const textOf = (value: Py | undefined) => (isObject(value) && typeof value.get("text") === "string" ? (value.get("text") as string) : undefined);

function flipFirst(text: string): string {
  return (text[0] === "x" ? "y" : "x") + text.slice(1);
}

const TAMPERS: Tamper[] = [
  { name: "exit-code", field: "status", base: byId("version--version"), change: (expected) => expected.set("status", (expected.get("status") as bigint) + 1n) },
  { name: "stdout-byte", field: "stdout", base: byId("version--version"), change: (expected) => expected.set("stdout", new Map([["text", flipFirst(textOf(expected.get("stdout"))!)]])) },
  { name: "stderr-byte", field: "stderr", base: firstWith((expected) => !!textOf(expected.get("stderr"))), change: (expected) => expected.set("stderr", new Map([["text", flipFirst(textOf(expected.get("stderr"))!)]])) },
  {
    name: "missing-control-request", field: "requests", base: byId("windows--windows"), change: (expected) => {
      const connections = list(expected.get("requests"));
      list(connections[connections.length - 1]).pop();
    },
  },
  { name: "missing-daemon-request", field: "daemon_requests", base: firstWith((expected) => list(expected.get("daemon_requests")).length > 0), change: (expected) => void list(expected.get("daemon_requests")).pop() },
  {
    name: "telemetry-property", field: "telemetry", base: byId("windows--windows"), change: (expected) => {
      const properties = (list(expected.get("telemetry"))[0] as PyObject).get("properties") as PyObject;
      properties.set("exit_code", 7n);
    },
  },
  { name: "queued-record", field: "queued", base: byId("windows--windows"), change: (expected) => void list(expected.get("queued")).pop() },
  { name: "usage", field: "usage", base: byId("windows--windows"), change: (expected) => (expected.get("usage") as PyObject).set("recent", ["tabs"]) },
  { name: "flush", field: "flush", base: byId("windows--windows"), change: (expected) => (expected.get("flush") as PyObject).set("failures", 99n) },
  { name: "missing-file", field: "files", base: byId("windows--windows"), change: (expected) => void (expected.get("files") as PyObject).delete([...(expected.get("files") as PyObject).keys()][0]!) },
  {
    name: "file-mode", field: "files", base: byId("windows--windows"), change: (expected) => {
      const files = expected.get("files") as PyObject;
      const [rel, change] = [...files].find(([, value]) => list(value)[1] === "file")!;
      files.set(rel, list(change).map((part, index) => (index === 2 ? 0o644n : part)));
    },
  },
  { name: "helper-call", field: "helpers", base: firstWith((expected) => list(expected.get("helpers")).length > 0), change: (expected) => void list(expected.get("helpers")).push("tampered =eA==") },
  { name: "timed-out", field: "timed_out", base: byId("version--version"), change: (expected) => expected.set("timed_out", true) },
  {
    name: "digest-body", field: "stdout", base: firstWith((expected) => isObject(expected.get("stdout")) && (expected.get("stdout") as PyObject).has("sha256") && Number((expected.get("stdout") as PyObject).get("size")) < 1024 * 1024),
    change: (expected) => {
      const body = expected.get("stdout") as PyObject;
      const digest = body.get("sha256") as string;
      body.set("sha256", digest.slice(0, -1) + (digest.endsWith("0") ? "1" : "0"));
    },
  },
];

if (existsSync(programPath())) {
  const cases = loadCases();
  const rows: Py[] = [];
  const planned: { tamper: Tamper; base: string; id: string }[] = [];
  const bases = new Set<string>();
  const missing: string[] = [];
  for (const tamper of TAMPERS) {
    const base = tamper.base(cases);
    if (base === undefined) {
      missing.push(tamper.name);
      continue;
    }
    if (!bases.has(base.id)) {
      bases.add(base.id);
      rows.push(clone(base.row));
    }
    const row = clone(base.row) as PyObject;
    const id = `${base.id}--tampered-${tamper.name}`;
    row.set("id", id);
    tamper.change(row.get("expected") as PyObject);
    rows.push(row);
    planned.push({ tamper, base: base.id, id });
  }
  const root = mkdtempSync(join(tmpdir(), "ardia-parity-tamper-"));
  writeFileSync(join(root, "tampered.json"), dumps(rows));
  let result;
  try {
    result = await runEngineDetached({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const outcomes = new Map(result.outcomes.map((outcome) => [outcome.id, outcome]));
  test("every tamper found a case to change", () => {
    if (missing.length) throw new Error(`no base case for ${missing.join(", ")}`);
  }, 1000);
  for (const base of bases) {
    test(`untampered ${base} passes`, () => {
      const outcome = outcomes.get(base)!;
      if (!passed(outcome)) throw new Error(report(outcome));
    }, 1000);
  }
  for (const { tamper, id } of planned) {
    test(`the runner catches a tampered ${tamper.name} (${tamper.field})`, () => {
      const outcome = outcomes.get(id)!;
      const fields = outcome.mismatches.map(([field]) => field);
      if (outcome.problems.length || fields.length !== 1 || fields[0] !== tamper.field) {
        throw new Error(`expected exactly a ${tamper.field} mismatch, got problems ${JSON.stringify(outcome.problems)} and mismatches ${JSON.stringify(fields)}`);
      }
    }, 1000);
  }
}
