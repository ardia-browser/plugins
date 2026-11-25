export type ProviderInfo = {
  instanceId: string;
  driver: string;
  enabled: boolean;
  installed: boolean;
  status?: string;
  auth?: { status?: string };
  models: ReadonlyArray<{ slug: string; name?: string }>;
};

export type ModelOption = { instanceId: string; driver: string; slug: string; label: string; plan: string; signedIn: boolean };

export const DEFAULT_MODEL = "claude-sonnet-5-5";

const PLAN: Record<string, string> = { claudeAgent: "your Claude plan" };
const PREFERRED = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "gpt-5.4-mini", "gpt-6-astra", "gpt-6.1-sol"];

export function prettyModel(slug: string, name?: string): string {
  if (name && !/^[a-z0-9.-]+$/.test(name)) return name;
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(slug);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}`;
  return slug.replace(/^gpt-/, "GPT-");
}

export function modelOptions(providers: readonly ProviderInfo[]): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of providers) {
    if (!p.enabled || !p.installed || !PLAN[p.driver]) continue;
    const signedIn = p.auth?.status !== "unauthenticated";
    for (const m of p.models) {
      if (!PREFERRED.includes(m.slug)) continue;
      out.push({ instanceId: p.instanceId, driver: p.driver, slug: m.slug, label: prettyModel(m.slug, m.name), plan: PLAN[p.driver]!, signedIn });
    }
  }
  return out.sort((a, b) => PREFERRED.indexOf(a.slug) - PREFERRED.indexOf(b.slug));
}

const MODEL_VALUES: Record<string, string> = { "gpt-5-4-mini": "gpt-5.4-mini" };

export function pickModel(options: readonly ModelOption[], wantedValue: string | null): ModelOption | null {
  const wanted = wantedValue ? (MODEL_VALUES[wantedValue] ?? wantedValue) : null;
  return options.find((o) => o.slug === wanted && o.signedIn) ?? options.find((o) => o.slug === DEFAULT_MODEL && o.signedIn) ?? options.find((o) => o.signedIn) ?? options[0] ?? null;
}

export type TagRef = { id: string; title: string; url?: string | undefined };

const TAG_LINE = "\n\n⟦Tagged tabs⟧ ";

export function withTags(text: string, tags: readonly TagRef[]): string {
  if (!tags.length) return text;
  return `${text}${TAG_LINE}${tags.map((t) => `${t.title.replace(/[\n⟦⟧]/g, " ").slice(0, 80)} (tab ${t.id})`).join("; ")}`;
}

export function splitTags(text: string): { text: string; tags: { title: string; id: string | null }[] } {
  const at = text.lastIndexOf(TAG_LINE);
  if (at < 0) return { text, tags: [] };
  const tail = text.slice(at + TAG_LINE.length);
  return {
    text: text.slice(0, at),
    tags: tail.split("; ").map((t) => {
      const id = /\s*\(tab ([^)]*)\)$/.exec(t);
      return { title: id ? t.slice(0, id.index) : t, id: id?.[1] ?? null };
    }),
  };
}
