import fs from "node:fs";
import "./libc-loaded.ts";
import { supervise } from "../src/computer/supervise.ts";

const [script, result] = process.argv.slice(2) as [string, string];
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
const ran = await supervise("/bin/sh", ["/bin/sh", script], env);
fs.writeFileSync(result, JSON.stringify({ status: ran.status, signal: ran.signal ?? null, stdoutClosed: ran.stdoutClosed }));
process.exit(0);
