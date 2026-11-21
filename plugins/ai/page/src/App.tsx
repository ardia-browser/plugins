import { useEffect, useState } from "react";
import { ChatView } from "./ChatView";
import { currentPageLocation, isStaticPage, useContextTab } from "./pageLocation";
import { openingPrompts, resolveOpening } from "./openingPrompts.ts";
import { History } from "./History";
import { Centered, RuntimeStopped } from "./Notices";
import { SessionProvider, useSession } from "./session";
import { Welcome } from "./Welcome";
import { watchGlass } from "./glass";

export type Route = { kind: "chat"; chatId: string } | { kind: "new" } | { kind: "history" } | { kind: "welcome" };

const CHAT_ID = /^[A-Za-z0-9-]{8,64}$/;

export function routeOf(pathname: string): Route {
  const path = pathname.replace(/^\/+|\/+$/g, "");
  if (path === "history") return { kind: "history" };
  if (path === "welcome") return { kind: "welcome" };
  if (CHAT_ID.test(path) && path !== "history") return { kind: "chat", chatId: path };
  return { kind: "new" };
}

function NewChat({ search }: { search: string }) {
  const session = useSession();
  const [chatId] = useState(() => crypto.randomUUID());
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (session.api) void session.api.open(`${chatId}${search}`).catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)));
  }, [session.api]);
  if (failed) return <Centered testId="open-failed" title="This chat couldn't open" detail={failed} />;
  return null;
}

let openingResolved = false;

function resolveOpeningOnce() {
  if (openingResolved) return;
  openingResolved = true;
  const replaced = resolveOpening(location.href, isStaticPage(), () => crypto.randomUUID(), openingPrompts);
  if (replaced) history.replaceState(history.state, "", replaced);
}

function useLinksThroughHelper() {
  const session = useSession();
  useEffect(() => {
    const open = session.openUrl;
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || !/^https?:/i.test(link.href)) return;
      event.preventDefault();
      open(link.href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [session.openUrl]);
}

function Screen() {
  const session = useSession();
  useLinksThroughHelper();
  const here = currentPageLocation();
  const route = routeOf(here.path);
  const contextTab = useContextTab();
  if (session.screen.kind === "reconnecting") return <RuntimeStopped />;
  if (route.kind === "history") return <History />;
  if (route.kind === "welcome") return <Welcome />;
  if (route.kind === "new") return <NewChat search={here.search} />;
  return <ChatView chatId={route.chatId} contextTab={contextTab} />;
}

export function App() {
  resolveOpeningOnce();
  useEffect(() => watchGlass(), []);
  return (
    <SessionProvider>
      <div className="app">
        <Screen />
      </div>
    </SessionProvider>
  );
}
