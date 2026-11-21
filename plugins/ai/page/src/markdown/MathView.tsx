import { useEffect, useState } from "react";

type Katex = { renderToString(tex: string, options: Record<string, unknown>): string };
let katexLoad: Promise<Katex | null> | null = null;
const loadKatex = () => (katexLoad ??= import("katex").then((m) => m.default as unknown as Katex, () => null));

export function MathView({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadKatex().then((katex) => {
      if (!alive || !katex) return;
      try {
        setHtml(katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000 }));
      } catch {}
    });
    return () => {
      alive = false;
    };
  }, [tex, display]);
  const Tag = display ? "div" : "span";
  if (!html) return <Tag className={display ? "math math-display" : "math"}><code>{tex}</code></Tag>;
  return <Tag className={display ? "math math-display" : "math"} dangerouslySetInnerHTML={{ __html: html }} />;
}
