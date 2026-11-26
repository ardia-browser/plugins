#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ROOT, affected, isMain, listPlugins, loadPlugin, releaseInfo } from "./lib.mjs";

const ARDIA_PLUGIN = join(ROOT, "node_modules", ".bin", "ardia-plugin");

const HELP = `usage: node scripts/plugins.mjs <command> [plugin…] [options]

Commands, for every plugin under plugins/ or the ones named:
  list       print the plugins
               --changed <git ref>    only those a diff from <ref> to HEAD touches (all on shared changes)
               --files <file|->       only those the paths listed in <file> (one per line, - for stdin) touch
               --json                 print JSON
               --github-output        also write plugins=, js=, cli=, shared= and packages= to $GITHUB_OUTPUT
  build      run the plugin's package.json build script (cli: plugins/cli/main)
  typecheck  run its typecheck script
  test       run its test script
  check      build when it has a build script, then ardia-plugin check
               --cli-out <dir>        check the cli folder plugins/cli/build.sh made in <dir>/cli
  pack       build, then ardia-plugin pack into --out <dir> (default plugins/<name>/release), and check the
             archive's name against plugin.json's release.asset or release.assets
               --cli-out <dir>        take cli's registry assets from plugins/cli/build.sh's <dir>

cli is native: plugins/cli/build.sh builds its folder (bin/ardia is the Bun executable it compiles) and checks and
packs it with the stock ardia-plugin check and pack. --cli-out runs ardia-plugin check on that real folder. Without
--cli-out, check validates plugin.json and dist/index.js with stand-ins for the programs build.sh makes, and pack
skips it.
`;

function parse(argv) {
  const flags = {};
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--github-output" || arg === "-h" || arg === "--help") flags[arg.replace(/^-+/, "")] = true;
    else if (["--changed", "--files", "--out", "--cli-out"].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("--")) throw new Error(`there's no option ${arg}`);
    else names.push(arg);
  }
  return { flags, names };
}

function run(command, args, cwd) {
  process.stderr.write(`$ (cd ${cwd.replace(`${ROOT}/`, "")} && ${[command, ...args].join(" ")})\n`);
  const done = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${done.status} in ${cwd}`);
}

function capture(command, args, cwd) {
  const done = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${done.status} in ${cwd}`);
  return done.stdout;
}

const script = (plugin, name) => (plugin.packageJson?.scripts?.[name] ? plugin.packageDir : null);

function runScript(plugin, name) {
  const dir = script(plugin, name);
  if (!dir) {
    process.stderr.write(`${plugin.name}: no ${name} script, nothing to do\n`);
    return false;
  }
  run("pnpm", ["run", name], dir);
  return true;
}

function selected(names) {
  const all = listPlugins();
  if (!names.length) return all;
  return names.map((name) => all.find((plugin) => plugin.name === name) ?? loadPlugin(name));
}

function changedPaths(flags) {
  if (flags.files !== undefined) {
    const text = flags.files === "-" ? readFileSync(0, "utf8") : readFileSync(flags.files, "utf8");
    return text.split(/\r?\n/).filter(Boolean);
  }
  return capture("git", ["diff", "--no-renames", "--name-only", `${flags.changed}...HEAD`], ROOT).split("\n").filter(Boolean);
}

function list(flags) {
  const plugins = listPlugins();
  const result = flags.changed !== undefined || flags.files !== undefined ? affected(changedPaths(flags), plugins) : { plugins: plugins.map((p) => p.name), shared: true, packages: true };
  const js = result.plugins.filter((name) => name !== "cli");
  const cli = result.plugins.includes("cli");
  if (flags["github-output"] && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `plugins=${JSON.stringify(result.plugins)}\njs=${JSON.stringify(js)}\ncli=${cli}\nshared=${result.shared}\npackages=${result.packages}\n`);
  }
  process.stdout.write(flags.json ? `${JSON.stringify(result)}\n` : result.plugins.map((name) => `${name}\n`).join(""));
}

function checkCli(plugin, cliOut) {
  if (cliOut) {
    const built = join(resolve(cliOut), "cli");
    if (!existsSync(join(built, "plugin.json"))) throw new Error(`${built} has no plugin.json: run plugins/cli/build.sh ${cliOut} first`);
    run(ARDIA_PLUGIN, ["check", built], ROOT);
    return;
  }
  const stage = mkdtempSync(join(tmpdir(), "ardia-cli-check-"));
  const folder = join(stage, "cli");
  try {
    mkdirSync(join(folder, "dist"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(plugin.dir, "plugin.json"), "utf8"));
    delete manifest.$schema;
    writeFileSync(join(folder, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const mainBuilt = join(plugin.dir, "main", "dist", "index.js");
    writeFileSync(join(folder, manifest.main ?? "dist/index.js"), existsSync(mainBuilt) ? readFileSync(mainBuilt) : "\n");
    for (const program of manifest.contributes?.programs ?? []) {
      const to = join(folder, program.path);
      mkdirSync(join(to, ".."), { recursive: true });
      writeFileSync(to, "#!/bin/sh\n");
      chmodSync(to, 0o755);
    }
    process.stderr.write("cli: checking plugin.json with stand-ins for the programs plugins/cli/build.sh makes; pass --cli-out to check a real build\n");
    run(ARDIA_PLUGIN, ["check", folder], ROOT);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function check(plugin, flags) {
  if (plugin.name === "cli") return checkCli(plugin, flags["cli-out"]);
  if (script(plugin, "build")) runScript(plugin, "build");
  run(ARDIA_PLUGIN, ["check", plugin.dir], ROOT);
}

function packCli(plugin, flags) {
  const info = releaseInfo(plugin);
  if (!flags["cli-out"]) {
    process.stderr.write("cli: packs with plugins/cli/build.sh <out>; pass --cli-out <out> to collect its registry assets\n");
    return [];
  }
  const from = resolve(flags["cli-out"]);
  const out = resolve(flags.out ?? join(plugin.dir, "release"));
  mkdirSync(out, { recursive: true });
  const found = info.assets.filter((asset) => existsSync(join(from, asset.name)));
  if (!found.length) throw new Error(`${from} has none of ${info.assets.map((asset) => asset.name).join(", ")}`);
  for (const asset of found) {
    if (from !== out) for (const suffix of ["", ".sha256"]) copyFileSync(join(from, asset.name + suffix), join(out, asset.name + suffix));
    process.stdout.write(`${join(out, asset.name)}\n`);
  }
  return found.map((asset) => join(out, asset.name));
}

function pack(plugin, flags) {
  if (plugin.name === "cli") return packCli(plugin, flags);
  const info = releaseInfo(plugin);
  if (info.assets.length !== 1 || info.assets[0].platform !== "universal") throw new Error(`${plugin.rel} declares per-platform assets; pack them with its own build`);
  const [asset] = info.assets;
  if (script(plugin, "build")) runScript(plugin, "build");
  const report = JSON.parse(capture(ARDIA_PLUGIN, ["pack", plugin.dir, "--no-build", "--json", "--quiet"], ROOT));
  if (basename(report.file) !== asset.name) throw new Error(`ardia-plugin pack wrote ${basename(report.file)}, and plugin.json's release names ${asset.name}`);
  const out = resolve(flags.out ?? join(plugin.dir, "release"));
  mkdirSync(out, { recursive: true });
  const target = join(out, asset.name);
  if (resolve(report.file) !== target) {
    renameSync(report.file, target);
    renameSync(`${report.file}.sha256`, `${target}.sha256`);
    try {
      rmdirSync(join(plugin.dir, "release"));
    } catch {}
  }
  const line = readFileSync(`${target}.sha256`, "utf8").trim();
  if (line !== `${report.sha256}  ${asset.name}`) throw new Error(`${target}.sha256 says ${line}`);
  process.stdout.write(`${target} ${report.sha256}\n`);
  return [target];
}

const COMMANDS = {
  build: (plugin) => runScript(plugin, "build"),
  typecheck: (plugin) => runScript(plugin, "typecheck"),
  test: (plugin) => runScript(plugin, "test"),
  check,
  pack,
};

export function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return command ? 0 : 64;
  }
  let parsed;
  try {
    parsed = parse(rest);
  } catch (error) {
    process.stderr.write(`plugins: ${error.message}\n`);
    return 64;
  }
  if (parsed.flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    if (command === "list") {
      list(parsed.flags);
      return 0;
    }
    const action = COMMANDS[command];
    if (!action) {
      process.stderr.write(`plugins: there's no command ${command}\n\n${HELP}`);
      return 64;
    }
    const failed = [];
    for (const plugin of selected(parsed.names)) {
      try {
        action(plugin, parsed.flags);
      } catch (error) {
        failed.push(plugin.name);
        process.stderr.write(`plugins ${command} ${plugin.name}: ${error.message}\n`);
      }
    }
    if (failed.length) {
      process.stderr.write(`plugins ${command} failed for ${failed.join(", ")}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`plugins ${command}: ${error.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
