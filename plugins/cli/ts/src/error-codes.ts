export const SOCKET_ERROR_CODES: ReadonlySet<string> = new Set([
  "bad_request",
  "unknown_method",
  "unknown_command",
  "refused",
  "no_window",
  "failed",
  "unsupported_protocol",
  "password_manager_plugin",
]);

export function recordedSocketCode(code: string): string {
  return SOCKET_ERROR_CODES.has(code) ? code : "other";
}
