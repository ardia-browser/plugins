import { ardiaHost } from "./host.ts";

export const ARDIA_CLAUDE_TOOLS: ReadonlyArray<string> = [];

export function claudeToolsForArdia(): ReadonlyArray<string> | null {
  return ardiaHost() ? ARDIA_CLAUDE_TOOLS : null;
}
