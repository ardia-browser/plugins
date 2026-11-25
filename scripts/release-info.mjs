#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findByTag, releaseInfo } from "./lib.mjs";

const HELP = `usage: node scripts/release-info.mjs <tag> [--github-output]

Finds the plugin whose plugin.json release.tagPrefix and version make <tag> (like cli-v0.8.0), and prints what its
release is as JSON: dir, name, id, title, version, tag, repo, prerelease (the version has a -), native (a sidecar,
programs or permissions.control, as the registry ranks it), platforms and the archive names release.asset or
release.assets expand to. It fails when the tag's version isn't plugin.json's. --github-output also writes each
field to $GITHUB_OUTPUT (arrays and objects as JSON).
`;

export function infoForTag(tag) {
  return releaseInfo(findByTag(tag));
}

function main(argv) {
  const args = argv.filter((arg) => arg !== "--github-output");
  if (!args.length || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(HELP);
    return args.length ? 0 : 64;
  }
  if (args.length !== 1) {
    process.stderr.write(HELP);
    return 64;
  }
  let info;
  try {
    info = infoForTag(args[0]);
  } catch (error) {
    process.stderr.write(`release-info: ${error.message}\n`);
    return 1;
  }
  if (argv.includes("--github-output")) {
    if (!process.env.GITHUB_OUTPUT) {
      process.stderr.write("release-info: --github-output needs $GITHUB_OUTPUT\n");
      return 64;
    }
    const lines = Object.entries(info).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    lines.push(`asset_names=${JSON.stringify(info.assets.map((asset) => asset.name))}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
