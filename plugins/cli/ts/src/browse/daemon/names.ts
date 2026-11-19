export const ALIASES: Readonly<Record<string, string>> = {
  goto: "open",
  navigate: "open",
  key: "press",
  scrollinto: "scrollintoview",
  quit: "close",
  exit: "close",
  geolocation: "geo",
};

export const MUTATING: ReadonlySet<string> = new Set([
  "open", "click", "dblclick", "type", "fill", "press", "keyboard", "keydown", "keyup", "hover", "check", "uncheck",
  "select", "drag", "upload", "download", "scroll", "scrollintoview", "mouse", "back", "forward", "reload", "tab",
  "find", "auth", "pushstate", "eval", "dialog", "batch", "storage", "cookies", "set", "state", "clipboard", "close", "script", "flow",
]);

export const SKIPPED: Readonly<Record<string, string>> = {
  connect: "ardia browse always drives the running Ardia (pick the endpoint with --data-dir, --port or --ws)",
  inspect: "opening DevTools on the user's tab isn't something the ardia command does",
  install: "Ardia is the browser; there's nothing to install",
  upgrade: "Ardia updates the ardia command itself",
  doctor: "run `ardia browse session info` instead",
  dashboard: "not part of ardia browse",
  chat: "Ardia has no AI features, by the owner's decision",
  mcp: "not part of ardia browse",
  profiles: "ardia browse never reads browser profiles",
  confirm: "action confirmation (--confirm-actions) isn't part of ardia browse",
  deny: "action confirmation (--confirm-actions) isn't part of ardia browse",
  swipe: "iOS isn't supported",
  tap: "iOS isn't supported",
  device: "iOS isn't supported",
  skills: "use `ardia --skill` (or `ardia skills get --full`) to print the skill, `ardia skills install` to copy it",
};

export function canonical(name: string): string {
  return Object.hasOwn(ALIASES, name) ? (ALIASES[name] as string) : name;
}
