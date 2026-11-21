import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ArdiaApi, Values } from "./api";
import type { Connection } from "./connection";
import { modelOptions, type ModelOption, type ProviderInfo } from "./models";
import { SessionCore, type SessionSnapshot } from "./sessionCore";
import type { Screen } from "./sessionState";
import type { ShellThread } from "./shellState";
import { openTransport } from "./transport";

export type { ShellThread };

export type Session = {
  screen: Screen;
  connection: Connection | null;
  api: ArdiaApi | null;
  connected: boolean | null;
  error: string | null;
  reconnecting: boolean;
  retry(): void;
  providers: ProviderInfo[] | null;
  models: ModelOption[];
  projectId: string | null;
  threads: ShellThread[];
  shellLoaded: boolean;
  values: Values;
  openUrl: ((url: string) => void) | null;
  refreshProviders(): Promise<void>;
  ensureProject(): Promise<string>;
  setValues(values: Values): void;
};

const SessionContext = createContext<Session | null>(null);

export const useSession = () => useContext(SessionContext)!;

export function sessionOf(core: SessionCore | null, snapshot: SessionSnapshot | null): Session {
  const screen = snapshot?.screen ?? { kind: "connecting" };
  return {
    screen,
    connection: snapshot?.connection ?? null,
    api: (snapshot?.api as ArdiaApi | null) ?? null,
    connected: screen.kind === "ready" ? true : screen.kind === "connecting" ? null : false,
    error: screen.kind === "reconnecting" ? screen.error : null,
    reconnecting: screen.kind === "reconnecting" && !screen.canRetry,
    retry: () => core?.retry(),
    providers: snapshot?.providers ?? null,
    models: snapshot?.providers ? modelOptions(snapshot.providers) : [],
    projectId: snapshot?.projectId ?? null,
    threads: snapshot?.threads ?? [],
    shellLoaded: snapshot?.shellLoaded ?? false,
    values: snapshot?.values ?? {},
    openUrl: snapshot?.openUrl ?? null,
    refreshProviders: () => core?.refreshProviders() ?? Promise.resolve(),
    ensureProject: () => (core ? core.ensureProject() : Promise.reject(new Error("The assistant is still getting ready. Try again in a moment."))),
    setValues: (values) => core?.setValues(values),
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [core, setCore] = useState<SessionCore | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  useEffect(() => {
    const next = new SessionCore({ openTransport });
    const unsubscribe = next.subscribe(() => setSnapshot(next.getSnapshot()));
    setCore(next);
    next.start();
    return () => {
      unsubscribe();
      next.stop();
    };
  }, []);
  const value = useMemo(() => sessionOf(core, snapshot), [core, snapshot]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
