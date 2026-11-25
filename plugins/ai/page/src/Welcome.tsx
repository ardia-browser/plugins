import { useEffect, useState } from "react";
import { SignInRows } from "./Notices";
import { useSession } from "./session";
import { shownMode } from "./welcomeMode.ts";

const MODES = [
  { value: "browser", title: "Browser first", detail: "New Tab is search. The assistant opens beside your page when you ask for it." },
  { value: "ai", title: "AI first", detail: "New Tab is a chat, on the left. A typed address still opens a plain tab." },
];

export function Welcome() {
  const session = useSession();
  const [chosen, setMode] = useState<string | null>(null);
  const mode = shownMode(session.values, chosen);
  useEffect(() => {
    document.title = "Set up AI";
  }, []);
  const choose = (value: string) => {
    setMode(value);
    void session.api?.setValue("mode", value).catch(() => undefined);
  };
  return (
    <div className="scroll">
      <div className="center" data-testid="welcome">
        <h1>Set up the assistant</h1>
        <p>It runs on your own subscription and only sees the tabs you give it.</p>
        <SignInRows />
        <div className="segmented" role="radiogroup">
          {MODES.map((m) => (
            <button key={m.value} className={mode === m.value ? "on" : ""} role="radio" aria-checked={mode === m.value} onClick={() => choose(m.value)} data-testid={`mode-${m.value}`}>
              {m.title}
            </button>
          ))}
        </div>
        <p>{MODES.find((m) => m.value === mode)?.detail} Change it later in Settings › AI.</p>
        <div className="buttons">
          <button className="btn go" onClick={() => void session.api?.open(crypto.randomUUID())}>
            Start a chat ↩
          </button>
        </div>
      </div>
    </div>
  );
}
