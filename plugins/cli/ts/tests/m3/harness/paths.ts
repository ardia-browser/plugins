import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS = path.dirname(fileURLToPath(import.meta.url));
export const M3_TS = path.dirname(HARNESS);
export const TS = path.resolve(M3_TS, "..", "..");
export const CLI = path.dirname(TS);

export const DATA_ROOT = process.env["ARDIA_M3_DATA_ROOT"] || M3_TS;
export const FIXTURES = path.join(TS, "tests", "fixtures", "browse");

export const SCENARIOS = path.join(DATA_ROOT, "scenarios");
export const TRANSCRIPTS = path.join(DATA_ROOT, "transcripts");
export const LINK_SCENARIOS = path.join(DATA_ROOT, "link-scenarios");
export const LINK_TRANSCRIPTS = path.join(DATA_ROOT, "link-transcripts");
export const PROTOCOL_SCHEMA = path.join(DATA_ROOT, "protocol.schema.json");
export const ELASTIC = path.join(DATA_ROOT, "elastic.json");

export const TAP = path.join(M3_TS, "tap.ts");
export const LINK_DRIVER = path.join(M3_TS, "link-driver.ts");
export const CLIENT_MAIN = path.join(TS, "src", "main.ts");
export const CLIENT_PRELOAD = path.join(HARNESS, "client-preload.ts");
export const DAEMON_METRICS = path.join(TS, "src", "browse", "metrics.ts");
export const BROWSE_LIBRARY = path.join(TS, "src", "browse", "js", "js.library.js.txt");
export const PYTHON_COMMAND_METRICS = path.join(HARNESS, "python-command-metrics.json");
export const BUILT_PROGRAM = path.join(TS, "dist", "ardia-ts");
export const PROGRAM_ENV = "ARDIA_M3_TS_PROGRAM";

export function tsProgram(): string {
  return process.env[PROGRAM_ENV] || BUILT_PROGRAM;
}
