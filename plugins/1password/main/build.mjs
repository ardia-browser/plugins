import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const sdk = (path) => here(`vendor/plugin-sdk/src/${path}`);

export const sdkAliases = {
  "@ardia/plugin-sdk/credentials": sdk("credentials.ts"),
  "@ardia/plugin-sdk/testing": sdk("testing.ts"),
};

const shared = { bundle: true, platform: "neutral", target: "es2022", legalComments: "none", charset: "utf8", alias: sdkAliases, logLevel: "warning" };

export async function bundleForTests(entry) {
  const built = await build({ ...shared, entryPoints: [entry], format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
}

export async function bundleMain(outfile = here("dist/main.js")) {
  await build({ ...shared, entryPoints: [here("src/index.ts")], outfile, format: "iife", minifySyntax: true });
  const bundled = readFileSync(outfile, "utf8")
    .replace(/\/\* @__PURE__ \*\/ /g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\/ /.test(line))
    .join("\n");
  writeFileSync(outfile, bundled);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundleMain();
