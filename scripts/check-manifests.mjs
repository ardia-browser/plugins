#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help") || args.length < 1) {
  console.log(`Usage: check-manifests.mjs <plugin.schema.json path or URL> [plugin…]   (CI passes schema/plugin.schema.json)
  Checks each plugins/<name>/plugin.json against Ardia's published plugin schema (the one Ardia writes beside
  config.schema.json and keeps in ardia-browser/ardia at apps/cli/ardia_cli/schemas/plugin.schema.json).
  Needs ajv (npm i --no-save ajv@8). Settings-only plugins (no "manifest" key) are checked for a name only.`);
  process.exit(args.includes("--help") ? 0 : 1);
}
const [schemaSource, ...only] = args;
const schemaText = /^https?:\/\//.test(schemaSource) ? await (await fetch(schemaSource)).text() : readFileSync(schemaSource, "utf8");
const { default: Ajv2020 } = await import("ajv/dist/2020.js");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(JSON.parse(schemaText));

const root = resolve(new URL("..", import.meta.url).pathname, "plugins");
const names = only.length ? only : readdirSync(root).filter((n) => existsSync(join(root, n, "plugin.json")));
let failed = 0;
for (const name of names) {
  const manifest = JSON.parse(readFileSync(join(root, name, "plugin.json"), "utf8"));
  const problems = [];
  if (manifest.name !== name) problems.push(`name is ${JSON.stringify(manifest.name)}, but the folder is ${name}`);
  if ("manifest" in manifest && !validate(manifest)) problems.push(...validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`));
  if (problems.length) {
    failed++;
    console.log(`✖ ${name}\n${problems.map((p) => `  ${p}`).join("\n")}`);
  } else console.log(`✔ ${name}`);
}
process.exit(failed ? 1 : 0);
