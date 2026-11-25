import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}.build`;

export async function load(entry) {
  const result = await build({
    entryPoints: [`${root}src/${entry}.ts`],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    logLevel: "silent",
    external: ["@ardia/plugin-sdk", "@ardia/plugin-sdk/*"],
  });
  mkdirSync(out, { recursive: true });
  const file = `${out}/${entry}-${process.pid}.mjs`;
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
