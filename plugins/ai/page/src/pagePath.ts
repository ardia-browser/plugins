export type PageLocation = { path: string; search: string };

export function pageLocation(href: string, staticPage: boolean): PageLocation {
  const url = new URL(href);
  if (!staticPage) return { path: url.pathname, search: url.search };
  const ardiaPath = url.searchParams.get("ardiaPath") ?? "/";
  const inner = new URL(ardiaPath.startsWith("/") ? ardiaPath : `/${ardiaPath}`, "http://page.invalid");
  return { path: inner.pathname, search: inner.search };
}

export function pageHref(href: string, path: string, staticPage: boolean): string {
  if (!staticPage) return path;
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  if (path !== "/") url.searchParams.set("ardiaPath", path);
  return `${url.pathname}${url.search}`;
}
