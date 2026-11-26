#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".ardia-packages");
const PACKAGES = [
  { name: "@ardia/plugin-sdk", file: "plugin-sdk.tgz", pattern: /^ardia-plugin-sdk-.+\.tgz$/ },
  { name: "@ardia/plugin-cli", file: "plugin-cli.tgz", pattern: /^ardia-plugin-cli-.+\.tgz$/ },
];

const HELP = `usage: node scripts/ardia-packages.mjs <dir>    use the @ardia/plugin-sdk and @ardia/plugin-cli tarballs in <dir>
       node scripts/ardia-packages.mjs --clear  go back to the versions on npm

The tarballs are copied to .ardia-packages/ as they are, and pnpm install resolves both packages from there until
--clear. A tarball whose package.json still names a workspace: dependency or points its exports at sources it doesn't
ship is refused: pack it with pnpm pack.
`;

function manifestOf(tarball) {
  return JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
}

function shipped(tarball) {
  return new Set(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean).map((entry) => entry.replace(/^package\//, "")));
}

function targets(value, found = []) {
  if (typeof value === "string") found.push(value.replace(/^\.\//, ""));
  else if (value && typeof value === "object") for (const entry of Object.values(value)) targets(entry, found);
  return found;
}

export function packedProblems(pkg, files) {
  const problems = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) if (String(spec).startsWith("workspace:")) problems.push(`${field}.${name} is ${spec}`);
  }
  for (const target of [...targets(pkg.exports), ...targets(pkg.main), ...targets(pkg.types)]) {
    if (!target.endsWith("package.json") && !target.includes("*") && !files.has(target)) problems.push(`${target} is named but not in the tarball`);
  }
  return problems;
}

function use(dir) {
  const given = readdirSync(dir);
  const found = PACKAGES.map((entry) => {
    const matches = given.filter((name) => entry.pattern.test(name)).sort();
    if (!matches.length) throw new Error(`${dir} has no ${entry.name} tarball (${entry.pattern})`);
    return { ...entry, tarball: join(dir, matches.at(-1)) };
  });
  const listed = {};
  for (const entry of found) {
    const pkg = manifestOf(entry.tarball);
    if (pkg.name !== entry.name) throw new Error(`${entry.tarball} holds ${pkg.name}, not ${entry.name}`);
    const problems = packedProblems(pkg, shipped(entry.tarball));
    if (problems.length) throw new Error(`${entry.tarball} isn't packed for installing:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    listed[entry.name] = { version: pkg.version, file: entry.file, from: entry.tarball };
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const entry of found) {
    copyFileSync(entry.tarball, join(out, entry.file));
    process.stdout.write(`${entry.name}@${listed[entry.name].version} from ${entry.tarball}\n`);
  }
  writeFileSync(join(out, "packages.json"), `${JSON.stringify(listed, null, 2)}\n`);
}

function main(argv) {
  const [arg] = argv;
  if (!arg || arg === "-h" || arg === "--help") {
    process.stdout.write(HELP);
    return arg ? 0 : 64;
  }
  if (arg === "--clear") {
    rmSync(out, { recursive: true, force: true });
    process.stdout.write("pnpm install now takes @ardia/plugin-sdk and @ardia/plugin-cli from npm\n");
    return 0;
  }
  if (!existsSync(arg)) {
    process.stderr.write(`ardia-packages: ${arg} doesn't exist\n`);
    return 66;
  }
  try {
    use(resolve(arg));
    return 0;
  } catch (error) {
    process.stderr.write(`ardia-packages: ${error.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
