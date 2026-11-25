import { useEffect } from "react";
import { Centered } from "./Notices";
import { useSession, type ShellThread } from "./session";

const RUNNING = new Set(["running", "working", "starting", "queued", "preparing", "waiting"]);

function when(ms: number): string {
  if (!ms) return "";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 7) return new Date(ms).toLocaleDateString([], { weekday: "short" });
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function groupThreads(threads: readonly ShellThread[]) {
  const live = threads.filter((t) => !t.archived);
  return {
    running: live.filter((t) => RUNNING.has(t.status)),
    snoozed: live.filter((t) => t.snoozed && !RUNNING.has(t.status)),
    earlier: live.filter((t) => !t.snoozed && !RUNNING.has(t.status)),
  };
}

function Section({ title, threads }: { title: string; threads: ShellThread[] }) {
  const session = useSession();
  if (!threads.length) return null;
  return (
    <>
      <div className="section">{title}</div>
      {threads.map((t) => (
        <button key={t.id} className="entry" onClick={() => void session.api?.open(t.id)} data-testid="history-entry">
          <span className="label">{t.title || "New chat"}</span>
          {RUNNING.has(t.status) && <i className="dot" />}
          <span className="when">{when(t.updatedAt)}</span>
        </button>
      ))}
    </>
  );
}

export function History() {
  const session = useSession();
  useEffect(() => {
    document.title = "AI chats";
  }, []);
  const groups = groupThreads(session.threads);
  if (!session.shellLoaded) return <Centered testId="history-loading" title="Loading chats…" />;
  if (!session.threads.some((t) => !t.archived)) return <Centered testId="history-empty" title="No chats yet" detail="Chats you start appear here, each opening as its own tab." />;
  return (
    <div className="scroll">
      <div className="history" data-testid="history">
        <Section title="Running" threads={groups.running} />
        <Section title="Snoozed" threads={groups.snoozed} />
        <Section title="Earlier" threads={groups.earlier} />
      </div>
    </div>
  );
}
