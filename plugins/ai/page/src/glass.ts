type GlassHandler = { postMessage(message: unknown): void };
type Region = { id: string; x: number; y: number; width: number; height: number; radius: number; kind: "control" | "panel"; state: "rest" | "lit" | "active" };

const MAX_REGIONS = 32;

function handler(): GlassHandler | null {
  const webkit = (window as unknown as { webkit?: { messageHandlers?: Record<string, GlassHandler | undefined> } }).webkit;
  return webkit?.messageHandlers?.ardiaGlass ?? null;
}

export const hostGlass = () => !!handler() && getComputedStyle(document.documentElement).getPropertyValue("--ardia-glass").trim() === "1";

function regions(): Region[] {
  const out: Region[] = [];
  const view = { width: window.innerWidth, height: window.innerHeight };
  document.querySelectorAll<HTMLElement>("[data-glass]").forEach((el, index) => {
    if (out.length >= MAX_REGIONS) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= view.height || r.left >= view.width) return;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return;
    const state = el.dataset.glassState === "active" ? "active" : el.dataset.glassState === "lit" || el.matches(":hover") ? "lit" : "rest";
    out.push({
      id: el.dataset.glassId ?? `g${index}`,
      x: Math.round(r.left * 2) / 2,
      y: Math.round(r.top * 2) / 2,
      width: Math.round(r.width * 2) / 2,
      height: Math.round(r.height * 2) / 2,
      radius: parseFloat(style.borderTopLeftRadius) || 0,
      kind: el.dataset.glass === "panel" ? "panel" : "control",
      state,
    });
  });
  return out;
}

export function watchGlass(): () => void {
  const post = handler();
  if (!post || !hostGlass()) return () => undefined;
  document.documentElement.dataset.hostGlass = "1";
  let frame = 0;
  let last = "";
  const flush = () => {
    frame = 0;
    const next = regions();
    const text = JSON.stringify(next);
    if (text === last) return;
    last = text;
    post.postMessage({ regions: next });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(document.documentElement);
  const mutations = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach((n) => n instanceof HTMLElement && resize.observe(n));
    schedule();
  });
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-glass", "data-glass-state", "class", "style"] });
  window.addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, true);
  document.addEventListener("mouseover", schedule, true);
  document.addEventListener("mouseout", schedule, true);
  schedule();
  return () => {
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
    document.removeEventListener("mouseover", schedule, true);
    document.removeEventListener("mouseout", schedule, true);
    delete document.documentElement.dataset.hostGlass;
    post.postMessage({ regions: [] });
  };
}
