import type { ReactNode } from "react";

export function textOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children && typeof children === "object" && "props" in children) return textOf((children as { props: { children?: ReactNode } }).props.children);
  return "";
}

export function fenceLanguage(className: string | undefined): string | null {
  const match = /(?:^|\s)language-([A-Za-z0-9_+#.-]+)/.exec(className ?? "");
  return match ? match[1]!.toLowerCase() : null;
}
