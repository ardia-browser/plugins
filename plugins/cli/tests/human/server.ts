import { join } from "node:path";

const pagesDir = import.meta.dir;

function respond(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/download/row15-served.txt") {
    return new Response("row15 served download", {
      headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="row15-served.txt"' },
    });
  }
  if (url.pathname === "/slow") {
    const ms = Math.min(5000, Number(url.searchParams.get("ms") ?? 500));
    const n = url.searchParams.get("n") ?? "0";
    return Bun.sleep(ms).then(() => Response.json({ items: [`result ${n}a`, `result ${n}b`] }));
  }
  const name = url.pathname.replace(/^\/+/, "");
  if (!/^row\d\d-[\w-]+\.html$/.test(name)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(pagesDir, name)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function startServer() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const v4 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
    try {
      const v6 = Bun.serve({ hostname: "::1", port: v4.port, fetch: respond });
      return { port: v4.port, stop: () => { v4.stop(true); v6.stop(true); } };
    } catch {
      v4.stop(true);
    }
  }
  throw new Error("could not bind 127.0.0.1 and ::1 on the same port");
}

if (import.meta.main) {
  const server = startServer();
  console.log(`serving ${pagesDir} on http://127.0.0.1:${server.port}/ and http://[::1]:${server.port}/`);
}
