export const FORBIDDEN_METHODS: ReadonlySet<string> = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]);

export class ForbiddenCommand extends Error {
  override readonly name = "ForbiddenCommand";
}

export function checkMethod(method: unknown): void {
  if (typeof method === "string" && FORBIDDEN_METHODS.has(method)) {
    throw new ForbiddenCommand(`ardia never sends ${method}: it's the user's browser`);
  }
}

export function checkCommand(command: unknown): void {
  if (command !== null && typeof command === "object" && !Array.isArray(command)) {
    checkMethod((command as { method?: unknown }).method);
  }
}

export function checkMessage(message: string | Uint8Array): void {
  const text = typeof message === "string" ? message : new TextDecoder("utf-8").decode(message);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ForbiddenCommand("ardia only sends JSON commands");
  }
  for (const command of Array.isArray(payload) ? payload : [payload]) checkCommand(command);
}
