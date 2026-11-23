export const DRIVER_COMMANDS = [
  "mcp", "list-tools", "describe", "call", "serve", "stop", "revoke", "status", "config", "telemetry", "recording",
  "update", "check-update", "doctor", "diagnose", "permissions", "autostart", "skills", "manifest", "extension",
  "perception", "channel", "cursor-theme", "cursor", "sessions", "history", "mcp-config",
];
export function label(argv: readonly string[]): string {
  const first = argv[0] ?? "help";
  if (DRIVER_COMMANDS.includes(first) || ["setup", "refresh", "help", "--version", "--help", "-h"].includes(first)) return first.replace(/^-+/, "");
  return "other";
}

