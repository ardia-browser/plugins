import fs from "node:fs";
import path from "node:path";
import { diff, entriesOf, containersOf, type View } from "../../src/browse/changes/report.ts";
import { renderReport } from "../../src/browse/changes/text.ts";
import { comparePixels, comparePngs, decodePng, encodePng } from "../../src/browse/media/png.ts";
import { render } from "../../src/browse/snapshot/render.ts";
import { buildTree, type Node, REF_ROLES, walk } from "../../src/browse/snapshot/tree.ts";
import { addSecret, redact } from "../../src/redact.ts";

const [dataDir = ".", only = ""] = process.argv.slice(2);
const wanted = only ? new Set(only.split(",")) : null;
const results: Record<string, number> = {};

function timed(label: string, reps: number, run: () => unknown): void {
  if (wanted && !wanted.has(label)) return;
  run();
  const samples: number[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  results[label] = Math.round((samples[samples.length >> 1] as number) * 100) / 100;
}

function jitCheck(): number {
  const started = performance.now();
  let total = 0;
  for (let i = 0; i < 5_000_000; i += 1) total = (total + i * 7) % 1000003;
  return total >= 0 ? performance.now() - started : 0;
}

addSecret("s3cr3t-token-value-0123456789abcdef");
const axNodes = JSON.parse(fs.readFileSync(path.join(dataDir, "ax.raw.json"), "utf8")).result.nodes;
const shotA = Buffer.from(fs.readFileSync(path.join(dataDir, "shot-a.b64"), "utf8").trim(), "base64");
const shotB = Buffer.from(fs.readFileSync(path.join(dataDir, "shot-b.b64"), "utf8").trim(), "base64");
let tree: Node[] = buildTree(axNodes);
for (const node of walk(tree)) if (REF_ROLES.has(node.role) && node.backend !== null) node.ref = `e${node.backend}`;
const text = render(tree);
const megabyte = `${text.slice(0, 1_000_000)}token=abc&`;
const plainMegabyte = text.slice(0, 1_000_000);

timed("snapshot_build_58k", 3, () => {
  tree = buildTree(axNodes);
  for (const node of walk(tree)) if (REF_ROLES.has(node.role) && node.backend !== null) node.ref = `e${node.backend}`;
});
timed("snapshot_render", 3, () => render(tree));
timed("snapshot_render_interactive", 3, () => render(tree, { interactive: true }));
timed("redact_1MB_hit", 5, () => redact(megabyte));
timed("redact_1MB_nohit", 5, () => redact(plainMegabyte));
const view = (loader: string): View => ({ target: "t", loader, url: "https://a.example/", title: "T", entries: entriesOf(tree), containers: containersOf(tree) });
timed("changes_diff_render_58k", 3, () => renderReport(diff(view("a"), view("a"))));
timed("changes_new_document_58k", 3, () => renderReport(diff(view("a"), view("b"))));
timed("png_decode_1280x800", 3, () => decodePng(shotA));
const imageA = decodePng(shotA);
const imageB = decodePng(shotB);
timed("png_compare_pixels", 3, () => comparePixels(imageA, imageB, 0.1));
timed("png_compare_total", 3, () => comparePngs(shotA, shotB, 0.1));
timed("png_encode_deflate6", 3, () => encodePng(imageA));
results.jit_check_loop = Math.round(jitCheck());
process.stdout.write(`${JSON.stringify({ runtime: "ts", ms: results })}\n`);
