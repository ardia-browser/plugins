import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SDK = /^@ardia\/plugin-sdk(\/.*)?$/;
let loads = 0;

export async function bundle(pluginDir, entry = "src/plugin.ts") {
  const dir = resolve(pluginDir);
  const result = await build({
    entryPoints: [join(dir, entry)],
    absWorkingDir: dir,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "@ardia/plugin-sdk",
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    write: false,
    logLevel: "silent",
    plugins: [{ name: "sdk-external", setup: (b) => b.onResolve({ filter: SDK }, (args) => ({ path: args.path, external: true })) }],
  });
  return result.outputFiles[0].text;
}

export async function loadPlugin(pluginDir, entry = "src/plugin.ts") {
  const dir = resolve(pluginDir);
  const out = join(dir, ".build");
  mkdirSync(out, { recursive: true });
  const file = join(out, `${basename(entry).replace(/\.[^.]+$/, "")}-${process.pid}-${++loads}.mjs`);
  writeFileSync(file, await bundle(dir, entry));
  return import(pathToFileURL(file).href);
}

export function readManifest(pluginDir) {
  return JSON.parse(readFileSync(join(resolve(pluginDir), "plugin.json"), "utf8"));
}
