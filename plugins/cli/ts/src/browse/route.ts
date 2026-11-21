const SHARED_VALUE_FLAGS = ["--port", "--ws", "--data-dir", "--timeout"];

export const PLUGIN_MODE = "ARDIA_BROWSE_FOR_PLUGIN";

export function pluginMode(): boolean {
  return Boolean(process.env[PLUGIN_MODE]);
}

export function invokesBrowse(argv: readonly string[]): boolean {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === "--json") {
      index += 1;
      continue;
    }
    if (SHARED_VALUE_FLAGS.includes(token.split("=")[0] as string)) {
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    return token === "browse";
  }
  return false;
}

export type NotesArgv = { hoisted: string[]; rest: string[] };

export function notesArgv(argv: readonly string[]): NotesArgv | undefined {
  const hoisted: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=")[0] as string;
    if (SHARED_VALUE_FLAGS.includes(name)) {
      if (token.includes("=")) {
        hoisted.push(token);
        index += 1;
        continue;
      }
      if (index + 1 >= argv.length) return undefined;
      hoisted.push(token, argv[index + 1] as string);
      index += 2;
      continue;
    }
    if (token === "--json") {
      hoisted.push(token);
      index += 1;
      continue;
    }
    break;
  }
  return argv[index] === "notes" ? { hoisted, rest: argv.slice(index + 1) } : undefined;
}
