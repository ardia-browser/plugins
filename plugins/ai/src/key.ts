import type { Ardia } from "@ardia/plugin-sdk";
import { AiError, NO_KEY_MESSAGE } from "./errors";

export const API_KEY_SECRET = "anthropic-api-key";

const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{8,}$/;

export async function readKey(ardia: Ardia): Promise<string> {
  const key = (await ardia.secrets.get(API_KEY_SECRET))?.trim();
  if (!key) throw new AiError("no-key", NO_KEY_MESSAGE);
  return key;
}

export function checkKey(value: string): string | null {
  const key = value.trim();
  if (!key) return "The key is empty.";
  if (!KEY_SHAPE.test(key)) return "That doesn't look like an Anthropic API key; they start with sk-ant-.";
  return null;
}

export async function askForKey(ardia: Ardia): Promise<{ saved: boolean; problem?: string }> {
  const value = await ardia.ui.inputBox({
    title: "Anthropic API Key",
    message: "Ardia keeps it in your Keychain and sends it only to api.anthropic.com.",
    placeholder: "sk-ant-…",
    password: true,
    confirmTitle: "Save",
  });
  if (value === undefined) return { saved: false };
  const problem = checkKey(value);
  if (problem) {
    await ardia.ui.toast("API key not saved", problem, { tone: "destructive", icon: "key" });
    return { saved: false, problem };
  }
  await ardia.secrets.set(API_KEY_SECRET, value.trim());
  await ardia.ui.toast("API key saved", "Ask AI is ready.", { tone: "success", icon: "key" });
  return { saved: true };
}

export async function forgetKey(ardia: Ardia): Promise<{ forgotten: boolean }> {
  await ardia.secrets.delete(API_KEY_SECRET);
  await ardia.ui.toast("API key forgotten", "Ask AI needs a key again before it can answer.", { icon: "key.slash" });
  return { forgotten: true };
}
