#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help") || args.length < 2) {
  console.log("Usage: build.mjs <t3code tree> <out dir> [--dev]\n  Bundles the AI plugin's chat page into <out dir>, resolving T3's contracts and Effect from <t3code tree>.");
  process.exit(args.includes("--help") ? 0 : 1);
}
const [tree, out] = args.map((a) => resolve(a));
const dev = args.includes("--dev");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, "src/main.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["safari17"],
  jsx: "automatic",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  nodePaths: [join(tree, "apps/web/node_modules")],
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  splitting: true,
  outdir: out,
  entryNames: "app",
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning",
});

copyFileSync(join(here, "index.html"), join(out, "index.html"));
copyFileSync(join(here, "src/styles.css"), join(out, "styles.css"));
copyFileSync(join(here, "src/tokens.css"), join(out, "tokens.css"));
const katex = dirname(createRequire(join(tree, "apps/web/package.json")).resolve("katex/package.json"));
mkdirSync(join(out, "katex"), { recursive: true });
copyFileSync(join(katex, "dist/katex.min.css"), join(out, "katex/katex.min.css"));
cpSync(join(katex, "dist/fonts"), join(out, "katex/fonts"), { recursive: true, filter: (path) => !/\.(ttf|woff)$/.test(path) });
console.log(`page built in ${out}`);
