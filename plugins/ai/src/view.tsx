import { Action, ActionPanel, Detail, useEffect, useState, type Ardia, type DetailMetadata, type ViewProps } from "@ardia/plugin-sdk";
import { createAborter } from "./abort";
import { streamMessage } from "./anthropic";
import { AiError, messageOf } from "./errors";
import { askForKey, readKey } from "./key";
import { DEFAULT_MAX_TOKENS, MODELS } from "./models";
import { buildPrompt, SYSTEM_PROMPT, type PageContext } from "./prompt";
import { currentModel } from "./provider";

export type AskContext = { query?: string };

type Shown =
  | { phase: "reading" }
  | { phase: "streaming" | "done"; text: string; model: string; page: PageContext | null }
  | { phase: "failed"; problem: string; code: string; page: PageContext | null };

const modelName = (id: string) => MODELS.find((model) => model.id === id)?.name ?? id;

async function readPage(ardia: Ardia): Promise<PageContext | null> {
  if (ardia.settings.get<boolean>("includePage", true) === false) return null;
  try {
    return await ardia.page.readActive({ markdown: true });
  } catch {
    return null;
  }
}

export function answerMetadata(model: string, page: PageContext | null): DetailMetadata[] {
  return [{ label: "Model", text: modelName(model), icon: "sparkles" }, page ? { label: "Page", text: page.title || page.url, icon: "doc.text" } : { label: "Page", text: "Not included", icon: "doc" }];
}

export const askView = (ardia: Ardia) =>
  function AskView({ context }: ViewProps<AskContext>) {
    const query = typeof context.query === "string" ? context.query : "";
    const [shown, setShown] = useState<Shown>({ phase: "reading" });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
      const aborter = createAborter();
      setShown({ phase: "reading" });
      void (async () => {
        let page: PageContext | null = null;
        try {
          const apiKey = await readKey(ardia);
          page = await readPage(ardia);
          if (aborter.signal.aborted) return;
          const model = currentModel(ardia);
          setShown({ phase: "streaming", text: "", model, page });
          const result = await streamMessage(ardia.net, {
            apiKey,
            model,
            system: SYSTEM_PROMPT,
            prompt: buildPrompt(query, page),
            maxTokens: DEFAULT_MAX_TOKENS,
            signal: aborter.signal,
            onText: (_delta, text) => setShown({ phase: "streaming", text, model, page }),
          });
          if (!aborter.signal.aborted) setShown({ phase: "done", text: result.text, model: result.model, page });
        } catch (error) {
          if (aborter.signal.aborted) return;
          setShown({ phase: "failed", problem: messageOf(error), code: error instanceof AiError ? error.code : "failed", page });
        }
      })();
      return () => aborter.abort("closed");
    }, [query, attempt]);

    const again = () => setAttempt((count) => count + 1);
    const setKey = async () => {
      const result = await askForKey(ardia);
      if (result.saved) again();
    };
    const heading = query.trim() ? `**${query.trim()}**\n\n` : "";

    if (shown.phase === "reading") return <Detail isLoading markdown={`${heading}Reading the page…`} />;

    if (shown.phase === "failed") {
      const needsKey = shown.code === "no-key" || shown.code === "bad-key";
      return (
        <Detail
          markdown={`${heading}**Couldn't answer.** ${shown.problem}`}
          actions={
            <ActionPanel>
              {needsKey ? <Action title="Set API Key" icon="key" onAction={setKey} /> : <Action title="Ask Again" icon="arrow.clockwise" onAction={again} />}
              {needsKey ? null : <Action title="Set API Key" icon="key" onAction={setKey} />}
            </ActionPanel>
          }
        />
      );
    }

    return (
      <Detail
        isLoading={shown.phase === "streaming"}
        markdown={`${heading}${shown.text || "…"}`}
        metadata={answerMetadata(shown.model, shown.page)}
        actions={
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Answer" content={shown.text} />
            <Action title="Ask Again" icon="arrow.clockwise" onAction={again} />
            <Action title="Set API Key" icon="key" onAction={setKey} />
          </ActionPanel>
        }
      />
    );
  };
