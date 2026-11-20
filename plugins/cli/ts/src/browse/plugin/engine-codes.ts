export const ENGINE_PREFIX = "ardia: ";

export type EngineCode = {
  readonly message: string;
  readonly match: "exact" | "suffix";
  readonly code: string;
  readonly exit: 1 | 2 | 77;
  readonly metric: string;
  readonly pending?: "act-lease-pr";
};

const exact = (message: string, code: string, metric: string, exit: 1 | 2 | 77 = 1): EngineCode => ({ message, match: "exact", code, exit, metric });
const suffix = (message: string, code: string, metric: string, exit: 1 | 2 | 77 = 1): EngineCode => ({ message, match: "suffix", code, exit, metric });

export const ENGINE_REFUSALS: readonly EngineCode[] = [
  exact("ardia: busy", "busy", "plugin_engine_busy"),
  exact("ardia: the page isn't taking input right now", "page_busy", "plugin_page_busy"),
  exact("ardia: page hidden", "page_hidden", "plugin_page_hidden"),
  exact("ardia: not delivered", "not_applied", "plugin_not_delivered"),
  exact("ardia: outcome unknown", "outcome_unknown", "plugin_outcome_unknown"),
  exact("ardia: the page changed after the input was sent", "document_changed", "plugin_lease_refused"),
  exact("ardia: tab_out_of_scope: the tab left the plugin's window", "tab_out_of_scope", "plugin_out_of_scope"),
  exact("ardia: no attached session has that sessionId", "tab_detached", "plugin_session_gone"),
  exact("ardia: there's no page to send input to", "tab_detached", "plugin_session_gone"),
  exact("ardia: that nodeId isn't in this page", "stale_ref", "plugin_node_gone"),
  exact("ardia: that backendNodeId isn't in this page", "stale_ref", "plugin_node_gone"),
  exact("ardia: that node left this page while the query was pending", "stale_ref", "plugin_node_gone"),
  exact("ardia: that point is outside the page", "outside_viewport", "plugin_outside_page"),
  exact("ardia: there's nothing there to send input to", "not_visible", "plugin_outside_page"),
  exact("ardia: this connection is closing", "connection_lost", "plugin_session_gone", 2),
  exact("ardia: pointer input and clicks go only to the page target's own session", "plugin_refused", "plugin_policy_refused", 77),
  exact("ardia: input isn't allowed for this session", "plugin_refused", "plugin_policy_refused", 77),
  exact("ardia: that input can't be made", "plugin_refused", "plugin_policy_refused", 77),
  exact("ardia: that session can't send input", "plugin_refused", "plugin_policy_refused", 77),
  { ...exact("ardia: no act lease for this page's current document", "act_lease_missing", "plugin_act_lease_missing", 77), pending: "act-lease-pr" },
  { ...exact("ardia: act lease ended before this input was delivered", "act_lease_ended", "plugin_act_lease_ended"), pending: "act-lease-pr" },
  suffix(" isn't allowed for a plugin", "plugin_refused", "plugin_policy_refused", 77),
  suffix(" can't be sent", "plugin_refused", "plugin_policy_refused", 77),
];

export const ENGINE_UNCODED: readonly string[] = [
  "ardia: ",
  "ardia: a command must be a JSON object",
  "ardia: a command needs an id and a method",
  "ardia: params must be an object",
  "ardia: a command with that id is still waiting for its reply",
  "ardia: too many commands are waiting for replies; closing the connection",
  " can't be answered",
  "no such credential",
  "no such tab",
  "tab out of scope",
  "no attached session",
];

export function engineRefusal(message: string): EngineCode | null {
  for (const entry of ENGINE_REFUSALS) {
    if (entry.match === "exact" ? message === entry.message : message.startsWith(ENGINE_PREFIX) && message.endsWith(entry.message) && message.length > ENGINE_PREFIX.length + entry.message.length) return entry;
  }
  return null;
}

export function refusalMessage(code: string): string {
  const found = ENGINE_REFUSALS.find((entry) => entry.code === code && entry.match === "exact");
  if (found === undefined) throw new Error(`no engine refusal has code ${code}`);
  return found.message;
}
