export const PLACED_VALUE_FLAGS: readonly string[] = ["--port", "--session"];
const SHARED_VALUE_FLAGS: readonly string[] = ["--port", "--ws", "--data-dir", "--timeout", "--session"];
const BROWSE_LIKE = new Set(["browse", "notes", "repl"]);
const UNTOUCHED = new Set(["computer"]);
const KEEPS_PORT = new Set(["scripts"]);

export type Placed = { argv: string[]; dropped: string[] };

function flagName(token: string): string {
  return token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
}

function commandAt(argv: readonly string[]): number {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === "--json") {
      index += 1;
      continue;
    }
    if (SHARED_VALUE_FLAGS.includes(flagName(token))) {
      if (!token.includes("=") && argv[index + 1] === "--") return argv.length;
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    return index;
  }
  return argv.length;
}

function sessionAfterCommand(argv: string[], at: number): Placed {
  const moved: string[] = [];
  const kept: string[] = [];
  for (let position = 0; position < at; position += 1) {
    const token = argv[position] as string;
    if (flagName(token) !== "--session") {
      kept.push(token);
      continue;
    }
    moved.push(token);
    if (!token.includes("=") && position + 1 < at) {
      moved.push(argv[position + 1] as string);
      position += 1;
    }
  }
  if (moved.length === 0) return { argv, dropped: [] };
  return { argv: [...kept, argv[at] as string, ...moved, ...argv.slice(at + 1)], dropped: [] };
}

export function placeEndpointFlags(given: readonly string[]): Placed {
  const argv = [...given];
  const at = commandAt(argv);
  const command = argv[at];
  if (command === undefined || UNTOUCHED.has(command)) return { argv, dropped: [] };
  if (BROWSE_LIKE.has(command)) return sessionAfterCommand(argv, at);
  const portKept = KEEPS_PORT.has(command);
  const out: string[] = [];
  const dropped: string[] = [];
  for (let position = 0; position < argv.length; position += 1) {
    const token = argv[position] as string;
    if (token === "--") {
      out.push(...argv.slice(position));
      break;
    }
    const name = flagName(token);
    const placed = PLACED_VALUE_FLAGS.includes(name) && !(name === "--port" && portKept);
    const valueMissing = !token.includes("=") && (position + 1 >= argv.length || argv[position + 1] === "--");
    if (!placed || valueMissing) {
      out.push(token);
      continue;
    }
    dropped.push(name);
    if (!token.includes("=")) position += 1;
  }
  return { argv: out, dropped };
}
