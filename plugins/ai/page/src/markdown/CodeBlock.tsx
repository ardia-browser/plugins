import { useEffect, useState } from "react";

type Highlighter = { codeToHtml(code: string, options: { lang: string; theme: string }): string };

export const CODE_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;
const MAX_HIGHLIGHTED = 200_000;
const highlighters = new Map<string, Promise<Highlighter | null>>();

function highlighterFor(language: string): Promise<Highlighter | null> {
  let load = highlighters.get(language);
  if (!load) {
    load = import("@pierre/diffs")
      .then(({ getSharedHighlighter }) =>
        getSharedHighlighter({ themes: Object.values(CODE_THEMES), langs: [language as never], preferredHighlighter: "highlights" }) as Promise<Highlighter>,
      )
      .catch(() => (language === "text" ? null : highlighterFor("text")));
    highlighters.set(language, load);
  }
  return load;
}

export function appearance(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const set = document.documentElement.dataset.ardiaAppearance;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useAppearance(): "light" | "dark" {
  const [mode, setMode] = useState(appearance);
  useEffect(() => {
    const update = () => setMode(appearance());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ardia-appearance"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return mode;
}

export function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const mode = useAppearance();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    setHtml(null);
    if (code.length > MAX_HIGHLIGHTED) return;
    const lang = language ?? "text";
    void highlighterFor(lang).then((h) => {
      if (!alive || !h) return;
      try {
        setHtml(h.codeToHtml(code, { lang, theme: CODE_THEMES[mode] }));
      } catch {
        try {
          setHtml(h.codeToHtml(code, { lang: "text", theme: CODE_THEMES[mode] }));
        } catch {}
      }
    });
    return () => {
      alive = false;
    };
  }, [code, language, mode]);
  const copy = () =>
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  return (
    <div className="code-block" data-language={language ?? "text"}>
      <div className="code-head">
        <span>{language ?? "text"}</span>
        <button type="button" className="code-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {html ? (
        <div className="code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
