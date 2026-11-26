#!/usr/bin/env node
import { build } from "esbuild";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [dirArg] = process.argv.slice(2);
if (!dirArg || dirArg === "-h" || dirArg === "--help") {
  process.stderr.write("usage: node build-sidecar.mjs <plugin dir>    bundles <plugin dir>/src/sidecar.ts into <plugin dir>/sidecar/server.mjs\n");
  process.exit(dirArg ? 0 : 64);
}

const dir = resolve(dirArg);
const entry = join(dir, "src", "sidecar.ts");
if (!existsSync(entry)) {
  process.stderr.write(`build-sidecar: ${entry} doesn't exist\n`);
  process.exit(66);
}

const result = await build({
  entryPoints: [entry],
  absWorkingDir: dir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  charset: "utf8",
  legalComments: "none",
  minifyWhitespace: true,
  write: false,
  logLevel: "warning",
});

const out = join(dir, "sidecar");
mkdirSync(out, { recursive: true });
const file = join(out, "server.mjs");
writeFileSync(file, `#!/usr/bin/env node\n${result.outputFiles[0].text}`);
chmodSync(file, 0o755);
process.stdout.write(`built sidecar/server.mjs from src/sidecar.ts (${result.outputFiles[0].contents.length} bytes)\n`);
