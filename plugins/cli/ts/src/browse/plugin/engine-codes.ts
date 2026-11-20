export type EngineCode = { readonly message: string; readonly code: string; readonly metric: string };

export const ENGINE_REFUSALS: readonly EngineCode[] = [
  { message: "ardia: tab_out_of_scope", code: "tab_out_of_scope", metric: "plugin_out_of_scope" },
  { message: "ardia: document_changed", code: "document_changed", metric: "plugin_lease_refused" },
  { message: "ardia: the page changed after the input was sent", code: "document_changed", metric: "plugin_lease_refused" },
  { message: "ardia: page hidden", code: "page_hidden", metric: "plugin_page_hidden" },
  { message: "ardia: busy", code: "busy", metric: "plugin_engine_busy" },
  { message: "ardia: the page isn't taking input right now", code: "page_busy", metric: "plugin_page_busy" },
];

export function engineRefusal(message: string): EngineCode | null {
  return ENGINE_REFUSALS.find((entry) => message === entry.message || message.startsWith(`${entry.message}:`)) ?? null;
}

export function refusalMessage(code: string): string {
  const found = ENGINE_REFUSALS.find((entry) => entry.code === code);
  if (found === undefined) throw new Error(`no engine refusal has code ${code}`);
  return found.message;
}
