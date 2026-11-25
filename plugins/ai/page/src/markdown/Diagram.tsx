import { useEffect, useRef, useState, type Ref } from "react";
import { CodeBlock } from "./CodeBlock";

type Pele = typeof import("pele/lazy");
let coreLoad: Promise<Pele | null> | null = null;
const loadCore = () => (coreLoad ??= import("pele/lazy").then((pele) => pele, () => null));
const typeLoads = new Map<string, Promise<boolean>>();
let purifier: { sanitize(svg: string, options: Record<string, unknown>): Node } | null = null;

async function sanitizer() {
  if (!purifier) {
    const DOMPurify = (await import("dompurify")).default;
    purifier = DOMPurify(window) as unknown as { sanitize(svg: string, options: Record<string, unknown>): Node };
  }
  return purifier;
}

export function Diagram({ source }: { source: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let destroy: (() => void) | null = null;
    setFailed(false);
    void (async () => {
      const pele = await loadCore();
      if (!pele) return void (alive && setFailed(true));
      let type: string | null = null;
      try {
        type = pele.detectType(source.trim()) as string | null;
      } catch {}
      if (!type) return void (alive && setFailed(true));
      let load = typeLoads.get(type);
      if (!load) typeLoads.set(type, (load = pele.load(type as never).then(() => true, () => false)));
      const purify = await sanitizer();
      if (!alive || !(await load) || !host.current) return void (alive && setFailed(!(await load)));
      const mounted = pele.mount(host.current, source.trim(), {
        links: false,
        images: false,
        zoom: false,
        autoDirection: false,
        sanitize: (svg: string) =>
          purify.sanitize(svg, {
            FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
            FORBID_TAGS: ["a", "image", "foreignObject", "style"],
            USE_PROFILES: { svg: true, svgFilters: true },
            RETURN_DOM_FRAGMENT: true,
          }),
        onError: () => alive && setFailed(true),
      } as never);
      destroy = () => mounted.destroy();
    })();
    return () => {
      alive = false;
      destroy?.();
    };
  }, [source]);
  return <DiagramView source={source} failed={failed} host={host} />;
}

export function DiagramView({ source, failed, host }: { source: string; failed: boolean; host?: Ref<HTMLDivElement> }) {
  return (
    <>
      <div className="diagram" ref={host} hidden={failed} />
      {failed ? <CodeBlock code={source} language="mermaid" /> : null}
    </>
  );
}
