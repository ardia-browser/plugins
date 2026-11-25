import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({
  entryPoints: [here("src/index.ts")],
  outfile: here("dist/index.js"),
  bundle: true,
  format: "iife",
  platform: "neutral",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "@ardia/plugin-sdk",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  legalComments: "none",
  charset: "utf8",
  minifyWhitespace: true,
  logLevel: "warning",
});
