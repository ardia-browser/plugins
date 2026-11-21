export type ShellThread = { id: string; title: string; status: string; updatedAt: number; snoozed: boolean; archived: boolean };

export function millisOf(value: unknown): number {
  if (!value) return 0;
  if (typeof value === "string") return Date.parse(value) || 0;
  if (typeof value === "object" && "epochMilliseconds" in (value as object)) return Number((value as { epochMilliseconds: number }).epochMilliseconds) || 0;
  return 0;
}

export function shellThread(t: Record<string, unknown>, archived: boolean): ShellThread {
  return {
    id: String(t.id ?? ""),
    title: String(t.title ?? ""),
    status: String(t.status ?? "idle"),
    updatedAt: millisOf(t.updatedAt),
    snoozed: millisOf(t.snoozedUntil) > Date.now(),
    archived: archived || millisOf(t.archivedAt) > 0,
  };
}

export function applyShell(threads: Map<string, ShellThread>, item: Record<string, unknown>): { threads: Map<string, ShellThread>; projectId: string | null } {
  if (item.kind === "snapshot") {
    const snapshot = item.snapshot as { projects?: Array<{ id?: string }>; threads?: Array<Record<string, unknown>> };
    const next = item.resolvedRepositoryIdentityRoots === undefined ? new Map<string, ShellThread>() : new Map(threads);
    for (const t of snapshot.threads ?? []) if (!t.deletedAt) next.set(String(t.id), shellThread(t, false));
    return { threads: next, projectId: snapshot.projects?.[0]?.id ? String(snapshot.projects[0].id) : null };
  }
  if (item.kind === "thread.updated") {
    const t = item.thread as Record<string, unknown>;
    const next = new Map(threads);
    if (t.deletedAt) next.delete(String(t.id));
    else next.set(String(t.id), shellThread(t, item.location === "archive"));
    return { threads: next, projectId: null };
  }
  if (item.kind === "thread.removed") {
    const next = new Map(threads);
    next.delete(String(item.threadId));
    return { threads: next, projectId: null };
  }
  if (item.kind === "project.updated") return { threads, projectId: String((item.project as { id?: string })?.id ?? "") || null };
  return { threads, projectId: null };
}
