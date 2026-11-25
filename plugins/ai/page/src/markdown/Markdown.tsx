import { memo, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  shouldPreserveAssistantLineBreaks,
} from "@t3tools/shared/markdownPipeline";
import { mathKind } from "@t3tools/shared/markdownMath";
import { CodeBlock } from "./CodeBlock";
import { Diagram } from "./Diagram";
import { MathView } from "./MathView";
import { fenceLanguage, textOf } from "./text";

export type LinkRenderer = (href: string, label: string, key: string) => ReactNode;

const SAFE_LINK = /^https?:\/\//i;
const REMARK_MATH: PluggableList[number] = [remarkMath, { singleDollarTextMath: true }];
const PLAIN: PluggableList = [REMARK_MATH, ...CHAT_MARKDOWN_REMARK_PLUGINS];
const BREAKS: PluggableList = [REMARK_MATH, ...CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS];

function codeChild(children: ReactNode): { className: string | undefined; code: string } | null {
  const only = Array.isArray(children) ? (children.length === 1 ? children[0] : null) : children;
  if (!only || typeof only !== "object" || !("props" in only)) return null;
  const props = (only as { props: { className?: string; children?: ReactNode } }).props;
  return { className: props.className, code: textOf(props.children).replace(/\n$/, "") };
}

function componentsFor(link: LinkRenderer | undefined): Components {
  return {
    a: ({ href, children }) => {
      const label = textOf(children) || href || "";
      if (!href || !SAFE_LINK.test(href)) return <>{children}</>;
      return link ? link(href, label, href) : <a href={href}>{children}</a>;
    },
    img: ({ alt, src }) => (src && SAFE_LINK.test(src) && link ? link(src, alt || src, src) : <>{alt ?? ""}</>),
    code: ({ className, children }) => {
      const math = mathKind(className);
      if (math) return <MathView tex={textOf(children)} display={math === "display"} />;
      return <code className={className}>{children}</code>;
    },
    pre: ({ children }) => {
      const block = codeChild(children);
      if (!block) return <pre>{children}</pre>;
      const language = fenceLanguage(block.className);
      if (language === "math" || mathKind(block.className) === "display") return <MathView tex={block.code} display />;
      if (language === "mermaid") return <Diagram source={block.code} />;
      return <CodeBlock code={block.code} language={language} />;
    },
    table: ({ children }) => (
      <div className="table-scroll">
        <table>{children}</table>
      </div>
    ),
  };
}

export const Markdown = memo(function Markdown({ text, link }: { text: string; link?: LinkRenderer }) {
  return (
    <ReactMarkdown
      remarkPlugins={shouldPreserveAssistantLineBreaks(text) ? BREAKS : PLAIN}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
      components={componentsFor(link)}
      urlTransform={defaultUrlTransform}
    >
      {text}
    </ReactMarkdown>
  );
});
