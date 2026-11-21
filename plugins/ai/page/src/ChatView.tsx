import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Ask, TabSummary } from "./api";
import { entriesOf, isWorking, screenOf, type Entry, type ProviderAuth, type Step } from "./chatState";
import { Composer, type ContextTab } from "./Composer";
import { Favicon, indexTabs, TabChip, type TabIndex } from "./Favicon";
import { Markdown } from "./markdown/Markdown";
import { pickModel, splitTags, type ModelOption, type TagRef } from "./models";
import { NotSignedIn, RuntimeStopped } from "./Notices";
import { useSession } from "./session";
import { useChat } from "./useChat";
import { openingPrompts } from "./openingPrompts.ts";

const siteOf = (origin: string | null) => {
  if (!origin) return null;
  try {
    return new URL(origin).host.replace(/^www\./, "");
  } catch {
    return null;
  }
};

const ASK_LINE: Record<Ask["kind"], (tab: string) => string> = {
  read: (tab) => `Can I read “${tab}”?`,
  act: (tab) => `Can I use “${tab}”?`,
  close: (tab) => `Can I close “${tab}”?`,
  group: (tab) => `Can I move “${tab}” into this chat's group?`,
  open: () => "Can I open a new tab?",
};

type Side = "in" | "out";
type Item =
  | { kind: "bubble"; side: Side; key: string; entry: Entry }
  | { kind: "status"; key: string; step?: Step; text?: string; error?: boolean }
  | { kind: "ask"; key: string; ask: Ask }
  | { kind: "typing"; key: string };

function itemsOf(entries: Entry[], asks: Ask[], typing: boolean): Item[] {
  const out: Item[] = [];
  for (const e of entries) {
    if (e.kind === "user") out.push({ kind: "bubble", side: "out", key: e.id, entry: e });
    else if (e.kind === "assistant") {
      if (e.text.trim()) out.push({ kind: "bubble", side: "in", key: e.id, entry: e });
    } else if (e.kind === "steps") for (const s of e.steps) out.push({ kind: "status", key: s.id, step: s });
    else if (e.kind === "error") {
      if (e.failureClass !== "usage_limit") out.push({ kind: "status", key: e.id, text: e.message, error: true });
    } else out.push({ kind: "status", key: e.id, text: e.message });
  }
  for (const a of asks) out.push({ kind: "ask", key: `ask-${a.id}`, ask: a });
  if (typing) out.push({ kind: "typing", key: "typing" });
  return out;
}

const sideOf = (item: Item | undefined): Side | null => (!item ? null : item.kind === "bubble" ? item.side : item.kind === "ask" || item.kind === "typing" ? "in" : null);

function StatusLine({ step, text, error, tabs }: { step?: Step | undefined; text?: string | undefined; error?: boolean | undefined; tabs: TabIndex }) {
  if (!step)
    return (
      <div className={`status${error ? " error" : ""}`} data-testid="status">
        {text}
      </div>
    );
  const tab = step.tabId ? tabs.byId.get(step.tabId) : step.url ? tabs.byUrl.get(step.url.split("#")[0]!) : undefined;
  const label = step.status === "done" && tab && step.tool === "ardia_read_tab" ? `Read ${tab.title}` : step.label;
  return (
    <div className={`status ${step.status}`} data-testid={`step-${step.tool}`}>
      {(tab || step.url) && <Favicon src={tab?.favicon} url={tab?.url ?? step.url} title={step.label} />}
      <span className="what">{label}</span>
    </div>
  );
}

function Bubble({ side, tail, children, testId }: { side: Side; tail: boolean; children: ReactNode; testId: string }) {
  return (
    <div className={`row ${side}`}>
      <div className={`bubble ${side}${tail ? " tail" : ""}`} data-testid={testId}>
        {children}
        {tail && (
          <svg className="tail-mark" viewBox="0 0 11 17" aria-hidden="true">
            <path d={side === "out" ? "M0 0 C0 8 3 14 11 17 C5 17 2 16 0 14 Z" : "M11 0 C11 8 8 14 0 17 C6 17 9 16 11 14 Z"} />
          </svg>
        )}
      </div>
    </div>
  );
}

function UserMessage({ entry, tail, tabs }: { entry: Extract<Entry, { kind: "user" }>; tail: boolean; tabs: TabIndex }) {
  const { text, tags } = splitTags(entry.text);
  return (
    <>
      {tags.length > 0 && (
        <div className="attachments">
          {tags.map((t, i) => {
            const tab = t.id ? tabs.byId.get(t.id) : undefined;
            return (
              <span className="attachment" key={i} title={tab?.url ?? t.title}>
                <Favicon src={tab?.favicon} url={tab?.url} title={t.title} />
                <span>{tab?.title ?? t.title}</span>
              </span>
            );
          })}
        </div>
      )}
      <Bubble side="out" tail={tail} testId="question">
        <div className="text">{text}</div>
      </Bubble>
    </>
  );
}

function PermissionAsk({ ask, tail, onAnswer }: { ask: Ask; tail: boolean; onAnswer: (choice: "allow" | "always" | "deny") => void }) {
  const site = siteOf(ask.origin);
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    go.current?.focus();
  }, []);
  return (
    <Bubble side="in" tail={tail} testId="permission">
      <div className="ask-line" role="alertdialog" aria-label="The assistant asks">
        {ASK_LINE[ask.kind](ask.tabTitle)}
        <small>{ask.kind === "open" ? `${ask.detail ?? ""} · this chat has read pages, so new addresses need your OK` : [site, ask.detail].filter(Boolean).join(" · ") || "This tab"}</small>
      </div>
      <div className="ask-buttons">
        <button ref={go} className="pill go" onClick={() => onAnswer("allow")} data-testid="allow">
          Allow
        </button>
        {site && (ask.kind === "read" || ask.kind === "act") && (
          <button className="pill" onClick={() => onAnswer("always")} title={`Always for ${site}`} data-testid="always">
            Always
          </button>
        )}
        <button className="pill" onClick={() => onAnswer("deny")} data-testid="deny">
          Don’t
        </button>
      </div>
    </Bubble>
  );
}

function useTabIndex(chatId: string, refreshKey: unknown) {
  const session = useSession();
  const [tabs, setTabs] = useState<TabSummary[]>([]);
  const load = useCallback(async () => {
    if (!session.api) return [];
    const list = (await session.api.tabs(chatId).catch(() => null))?.tabs ?? [];
    setTabs(list);
    return list;
  }, [session.api, chatId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  return { list: tabs, index: useMemo(() => indexTabs(tabs), [tabs]), load };
}

type Suggestion = { text: string; tag: TagRef | null };

function suggestionsFor(contextTab: ContextTab | null, tabs: readonly TabSummary[]): Suggestion[] {
  if (contextTab) {
    const tag = { id: contextTab.id, title: contextTab.title, url: contextTab.url };
    return [
      { text: "Summarize this page", tag },
      { text: "What are the key points?", tag },
      { text: "Explain it simply", tag },
    ];
  }
  const pages = tabs.filter((t) => /^https?:/.test(t.url)).slice(0, 2);
  const out: Suggestion[] = pages.map((t) => ({ text: `Summarize ${t.title.length > 32 ? `${t.title.slice(0, 31)}…` : t.title}`, tag: { id: t.id, title: t.title, url: t.url } }));
  if (tabs.filter((t) => /^https?:/.test(t.url)).length > 1) out.push({ text: "What do my open tabs have in common?", tag: null });
  return out;
}

function EmptyState({ suggestions, tabs, onPick }: { suggestions: Suggestion[]; tabs: TabIndex; onPick: (s: Suggestion) => void }) {
  return (
    <div className="empty" data-testid="empty">
      <div className="spark" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 2.5c.6 4.9 2.1 7.4 7.5 9.5-5.4 2.1-6.9 4.6-7.5 9.5-.6-4.9-2.1-7.4-7.5-9.5 5.4-2.1 6.9-4.6 7.5-9.5Z" />
        </svg>
      </div>
      <div className="empty-title">Ask anything, or about your tabs</div>
      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((s) => {
            const tab = s.tag ? tabs.byId.get(s.tag.id) : undefined;
            return (
              <button key={s.text} className="suggestion" data-glass="control" onClick={() => onPick(s)}>
                {s.tag && <Favicon src={tab?.favicon} url={tab?.url ?? s.tag.url} title={s.tag.title} />}
                <span>{s.text}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ChatView({ chatId, contextTab }: { chatId: string; contextTab: ContextTab | null }) {
  const session = useSession();
  const { chat, exists, asks, send, stop, answer, sendError } = useChat(chatId);
  const [modelSlug, setModelSlug] = useState<string | null>(() => localStorage.getItem("ardia.ai.model"));
  const model = pickModel(session.models, modelSlug ?? (typeof session.values.model === "string" ? session.values.model : null));
  const providerAuth: ProviderAuth | null = session.providers === null ? null : session.models.some((m) => m.signedIn) ? "authenticated" : "unauthenticated";
  const screen = screenOf({ connected: session.connected, providerAuth, chat, asks: asks.length });
  const entries = useMemo(() => entriesOf(chat), [chat]);
  const working = isWorking(chat);
  const { list: tabList, index: tabs, load: loadTabs } = useTabIndex(chatId, `${working}-${entries.length}`);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const last = entries[entries.length - 1];
  const streamingText = last?.kind === "assistant" && last.streaming && !!last.text.trim();
  const hasRunningStep = entries.some((e) => e.kind === "steps" && e.steps.some((s) => s.status === "running"));
  const typing = working && asks.length === 0 && !streamingText && !hasRunningStep;
  const items = useMemo(() => itemsOf(entries, asks, typing), [entries, asks, typing]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    if (exists === false && !chat.title) document.title = "New chat";
    else if (chat.title) document.title = chat.title;
  }, [chat.title, exists]);
  useEffect(() => {
    if (!openingPrompts.peek(chatId) || !model || screen !== "empty") return;
    const prompt = openingPrompts.take(chatId);
    if (prompt) void send(prompt, contextTab ? [contextTab] : [], model);
  }, [chatId, model, screen]);

  const chooseModel = (m: ModelOption) => {
    setModelSlug(m.slug);
    localStorage.setItem("ardia.ai.model", m.slug);
  };

  if (screen === "runtime-stopped") return <RuntimeStopped />;
  if (screen === "connecting") return <div className="app-blank" />;
  if (screen === "not-signed-in") return <NotSignedIn />;

  const limitEntry = screen === "limit-reached" ? [...entries].reverse().find((e) => e.kind === "error") : null;
  const contextWithUrl = contextTab ? { ...contextTab, url: contextTab.url ?? tabs.byId.get(contextTab.id)?.url } : null;
  const cite = (href: string, label: string, key: string) => (
    <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="cite-link">
      <TabChip tab={tabs.byUrl.get(href.split("#")[0]!)} url={href} title={label} />
    </a>
  );

  return (
    <>
      <div
        className="list"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <div className="column">
          {screen === "empty" ? (
            <>
              <EmptyState suggestions={suggestionsFor(contextWithUrl, tabList)} tabs={tabs} onPick={(s) => model && void send(s.text, s.tag ? [s.tag] : [], model)} />
              {sendError && (
                <div className="slot">
                  <div className="status error" data-testid="send-error">{sendError}</div>
                </div>
              )}
            </>
          ) : (
            <div className="thread" data-testid="thread" data-screen={screen}>
              {items.map((item, i) => {
                const side = sideOf(item);
                const tail = !!side && sideOf(items[i + 1]) !== side;
                const joined = !!side && sideOf(items[i - 1]) === side;
                const gap = joined ? " joined" : "";
                if (item.kind === "status")
                  return (
                    <div key={item.key} className="slot">
                      <StatusLine step={item.step} text={item.text} error={item.error} tabs={tabs} />
                    </div>
                  );
                if (item.kind === "typing")
                  return (
                    <div key={item.key} className={`slot${gap}`}>
                      <Bubble side="in" tail={tail} testId="working">
                        <span className="dots">
                          <i />
                          <i />
                          <i />
                        </span>
                      </Bubble>
                    </div>
                  );
                if (item.kind === "ask")
                  return (
                    <div key={item.key} className={`slot${gap}`}>
                      <PermissionAsk ask={item.ask} tail={tail} onAnswer={(c) => void answer(item.ask.id, c)} />
                    </div>
                  );
                const entry = item.entry;
                return (
                  <div key={item.key} className={`slot${gap}`}>
                    {entry.kind === "user" ? (
                      <UserMessage entry={entry} tail={tail} tabs={tabs} />
                    ) : entry.kind === "assistant" ? (
                      <Bubble side="in" tail={tail} testId="answer">
                        <div className="text prose">
                          <Markdown text={entry.text} link={cite} />
                        </div>
                      </Bubble>
                    ) : null}
                  </div>
                );
              })}
              {limitEntry && (
                <div className="slot">
                  <div className="status error" data-testid="limit">
                    You’ve reached your plan’s limit. {limitEntry.kind === "error" ? limitEntry.message : ""}
                  </div>
                </div>
              )}
              {sendError && (
                <div className="slot">
                  <div className="status error">{sendError}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <Composer
        working={working}
        placeholder={contextTab ? "Ask about this page" : "Ask anything"}
        contextTab={contextWithUrl}
        tabs={tabs}
        models={session.models}
        model={model}
        loadTabs={loadTabs}
        onModel={chooseModel}
        onSend={(text, tags) => {
          pinned.current = true;
          if (model) void send(text, tags, model);
        }}
        onStop={() => void stop()}
      />
    </>
  );
}

