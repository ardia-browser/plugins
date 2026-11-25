#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".ardia-packages");
const PACKAGES = [
  { name: "@ardia/plugin-sdk", file: "plugin-sdk.tgz", pattern: /^ardia-plugin-sdk-.+\.tgz$/ },
  { name: "@ardia/plugin-cli", file: "plugin-cli.tgz", pattern: /^ardia-plugin-cli-.+\.tgz$/ },
];

function usage() {
  process.stderr.write(
    [
      "usage: node scripts/ardia-packages.mjs <dir>    use the @ardia/plugin-sdk and @ardia/plugin-cli tarballs in <dir>",
      "       node scripts/ardia-packages.mjs --clear  go back to the versions on npm",
      "",
      "The tarballs land in .ardia-packages/, and pnpm install resolves both packages from there until --clear.",
      "",
    ].join("\n"),
  );
}

function published(pkg, versions) {
  const next = { ...pkg };
  for (const key of ["main", "module", "types", "exports"]) if (pkg.publishConfig?.[key] !== undefined) next[key] = pkg.publishConfig[key];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (!pkg[field]) continue;
    next[field] = Object.fromEntries(
      Object.entries(pkg[field]).map(([name, spec]) => {
        if (!String(spec).startsWith("workspace:")) return [name, spec];
        const version = versions.get(name);
        if (!version) throw new Error(`${pkg.name} depends on ${name} as ${spec}, and no tarball given has it`);
        return [name, `^${version}`];
      }),
    );
  }
  delete next.devDependencies;
  delete next.scripts;
  return next;
}

function normalize(dir) {
  const given = readdirSync(dir);
  const found = PACKAGES.map((entry) => {
    const matches = given.filter((name) => entry.pattern.test(name)).sort();
    if (!matches.length) throw new Error(`${dir} has no ${entry.name} tarball (${entry.pattern})`);
    return { ...entry, tarball: join(dir, matches.at(-1)) };
  });
  const work = mkdtempSync(join(tmpdir(), "ardia-packages-"));
  try {
    const unpacked = found.map((entry, i) => {
      const into = join(work, String(i));
      mkdirSync(into);
      execFileSync("tar", ["-xzf", entry.tarball, "-C", into]);
      const manifest = join(into, "package", "package.json");
      return { ...entry, into, manifest, pkg: JSON.parse(readFileSync(manifest, "utf8")) };
    });
    const versions = new Map(unpacked.map((entry) => [entry.pkg.name, entry.pkg.version]));
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const lock = {};
    for (const entry of unpacked) {
      if (entry.pkg.name !== entry.name) throw new Error(`${entry.tarball} holds ${entry.pkg.name}, not ${entry.name}`);
      writeFileSync(entry.manifest, `${JSON.stringify(published(entry.pkg, versions), null, 2)}\n`);
      if (Array.isArray(entry.pkg.files) && !entry.pkg.files.includes("src")) rmSync(join(entry.into, "package", "src"), { recursive: true, force: true });
      execFileSync("tar", ["-czf", join(out, entry.file), "-C", entry.into, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
      lock[entry.name] = { version: entry.pkg.version, file: entry.file, from: entry.tarball };
      process.stdout.write(`${entry.name}@${entry.pkg.version} from ${entry.tarball}\n`);
    }
    writeFileSync(join(out, "packages.json"), `${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const [arg] = process.argv.slice(2);
if (!arg || arg === "-h" || arg === "--help") {
  usage();
  process.exit(arg ? 0 : 64);
}
if (arg === "--clear") {
  rmSync(out, { recursive: true, force: true });
  process.stdout.write("pnpm install now takes @ardia/plugin-sdk and @ardia/plugin-cli from npm\n");
} else {
  if (!existsSync(arg)) {
    process.stderr.write(`ardia-packages: ${arg} doesn't exist\n`);
    process.exit(66);
  }
  normalize(resolve(arg));
}
