import { useCallback, useEffect, useState } from "react";
import type { Ask } from "./api";
import { applyStream, emptyChat, type Chat, type StreamItem } from "./chatState";
import { bannerStopper } from "./bannerStop";
import { withTags, type ModelOption, type TagRef } from "./models";
import { useSession } from "./session";

const uuid = () => crypto.randomUUID();

export function useChat(chatId: string) {
  const session = useSession();
  const { connection, api } = session;
  const [chat, setChat] = useState<Chat>(() => emptyChat(chatId));
  const [exists, setExists] = useState<boolean | null>(null);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(0);

  useEffect(() => {
    if (!connection) return;
    setChat(emptyChat(chatId));
    let unsubscribe: (() => void) | null = null;
    let alive = true;
    void connection
      .call((c) => c["orchestration.getThreadProjection"]({ threadId: chatId } as never))
      .then(
        () => alive && setExists(true),
        () => alive && setExists(false),
      )
      .then(() => {
        if (!alive) return;
        unsubscribe = connection.subscribe(
          (c) => c["orchestration.subscribeThread"]({ threadId: chatId } as never),
          (item: unknown) => setChat((current) => applyStream(current, item as StreamItem)),
          () => undefined,
        );
      });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [connection, chatId, subscribed]);

  useEffect(() => {
    if (!api) return;
    const onStopped = bannerStopper((reason) => {
      if (connection) void connection.call((c) => c["orchestration.dispatchCommand"]({ type: "thread.stop", commandId: uuid(), threadId: chatId, reason } as never)).catch(() => undefined);
    });
    return api.watch(
      chatId,
      (events) => {
        setAsks(events.asks);
        session.setValues(events.values);
        onStopped(events.stopped);
      },
      () => undefined,
    );
  }, [api, connection, chatId]);

  const send = useCallback(
    async (text: string, tags: TagRef[], model: ModelOption) => {
      if (!connection || !api) return;
      setSendError(null);
      try {
        const messageId = uuid();
        await api.send(chatId, tags.map((t) => t.id), messageId);
        const body = withTags(text, tags);
        if (exists) {
          await connection.call((c) =>
            c["orchestration.dispatchCommand"]({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: uuid(),
              threadId: chatId,
              messageId,
              text: body,
              attachments: [],
              modelSelection: { instanceId: model.instanceId, model: model.slug },
              dispatchMode: { type: "start_immediately" },
            } as never),
          );
        } else {
          const project = await session.ensureProject();
          await connection.call((c) =>
            c["orchestration.launchThread"]({
              commandId: uuid(),
              threadId: chatId,
              projectId: project,
              title: text.slice(0, 60) || "New chat",
              generateTitle: true,
              modelSelection: { instanceId: model.instanceId, model: model.slug },
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: { messageId, text: body, attachments: [] },
            } as never),
          );
          setExists(true);
          setSubscribed((n) => n + 1);
        }
      } catch (e) {
        setSendError(e instanceof Error ? e.message : String(e));
      }
    },
    [connection, api, chatId, exists, session],
  );

  const stop = useCallback(async () => {
    if (!connection || !api) return;
    await api.stop(chatId).catch(() => undefined);
    await connection.call((c) => c["orchestration.dispatchCommand"]({ type: "thread.stop", commandId: uuid(), threadId: chatId } as never)).catch(() => undefined);
  }, [connection, api, chatId]);

  const answer = useCallback(
    async (id: string, choice: "allow" | "always" | "deny") => {
      if (!api) return;
      setAsks((current) => current.filter((a) => a.id !== id));
      await api.answer(chatId, id, choice).catch(() => undefined);
    },
    [api, chatId],
  );

  return { chat, exists, asks, send, stop, answer, sendError };
}
