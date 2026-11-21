import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fenceLanguage } from "../page/src/markdown/text.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const tree = process.env.T3_TREE ?? join(homedir(), ".cache/ardia-ai-runtime/t3code");
const haveTree = existsSync(join(tree, "apps/web/node_modules/react-markdown"));

test("a fence's language comes from its class, lower-cased, or none", () => {
  assert.equal(fenceLanguage("language-TypeScript"), "typescript");
  assert.equal(fenceLanguage("hljs language-c++ x"), "c++");
  assert.equal(fenceLanguage(undefined), null);
  assert.equal(fenceLanguage("math-display"), null);
});

async function renderer() {
  const { build } = await import("esbuild");
  const dir = mkdtempSync(join(tmpdir(), "ardia-md-"));
  const entry = join(dir, "entry.tsx");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    entry,
    `import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from ${JSON.stringify(join(here, "../page/src/markdown/Markdown.tsx"))};
import { DiagramView } from ${JSON.stringify(join(here, "../page/src/markdown/Diagram.tsx"))};
export const renderDiagram = (failed) => renderToStaticMarkup(<DiagramView source="graph TD; A-->B" failed={failed} />);
export const render = (text, withLinks) => renderToStaticMarkup(<Markdown text={text} link={withLinks ? (href, label, key) => <a key={key} data-through-helper={href}>{label}</a> : undefined} />);`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    outfile: join(dir, "out.mjs"),
    nodePaths: [join(tree, "apps/web/node_modules")],
    alias: { react: realpathSync(join(tree, "apps/web/node_modules/react")), "react-dom": realpathSync(join(tree, "apps/web/node_modules/react-dom")) },
    logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    external: ["@pierre/diffs", "pele/lazy", "katex", "dompurify"],
  });
  const mod = await import(pathToFileURL(join(dir, "out.mjs")).href);
  rmSync(dir, { recursive: true, force: true });
  return Object.assign(mod.render, { diagram: mod.renderDiagram });
}

test("answers render through T3's pipeline: tables, code blocks, diagrams, math, alerts, and links only through the helper", { skip: !haveTree && "needs a T3 Code tree (T3_TREE)" }, async () => {
  const render = await renderer();
  const html = render(
    [
      "# Title",
      "",
      "| Browser | Year |",
      "| --- | --- |",
      "| Mosaic | 1993 |",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "```mermaid",
      "xychart-beta",
      "  bar [1, 2, 3]",
      "```",
      "",
      "Inline $x^2$ math.",
      "",
      "> [!NOTE]",
      "> Careful.",
      "",
      "[safe](https://example.com/a) [bad](javascript:alert(1)) ![pic](https://example.com/p.png)",
      "",
      "<script>alert(1)</script><b>bold</b>",
    ].join("\n"),
    true,
  );
  assert.match(html, /<table>[\s\S]*Mosaic[\s\S]*<\/table>/);
  assert.match(html, /class="code-block" data-language="ts"/);
  assert.match(html, /class="diagram"/);
  assert.match(html, /class="math"/);
  assert.match(html, /data-through-helper="https:\/\/example.com\/a"/);
  assert.match(html, /data-through-helper="https:\/\/example.com\/p.png"/, "an image is a link, never a fetch");
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /markdown-alert|Careful/);
});

test("a diagram that failed while its block was streaming keeps its drawing element, so the finished block can still draw", { skip: !haveTree && "needs a T3 Code tree (T3_TREE)" }, async () => {
  const render = await renderer();
  const failed = render.diagram(true);
  assert.match(failed, /<div class="diagram" hidden="">/);
  assert.match(failed, /class="code-block" data-language="mermaid"/);
  assert.match(render.diagram(false), /<div class="diagram"><\/div>/);
});
