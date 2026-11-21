const SHARED_VALUE_FLAGS = ["--port", "--ws", "--data-dir", "--timeout"];
export const VERBS = ["run", "install", "uninstall", "list"] as const;
export type Verb = (typeof VERBS)[number];

class SharedValueMissing extends Error {}

function takeShared(argv: readonly string[], start: number, into: string[]): number {
  let index = start;
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=", 1)[0] as string;
    if (SHARED_VALUE_FLAGS.includes(name)) {
      if (token.includes("=")) {
        into.push(token);
        index += 1;
        continue;
      }
      if (index + 1 >= argv.length) throw new SharedValueMissing(name);
      into.push(argv[index] as string, argv[index + 1] as string);
      index += 2;
      continue;
    }
    if (token === "--json") {
      into.push(token);
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

export type Arranged = { path: string[]; hoisted: string[]; rest: string[] };

export function arrange(argv: readonly string[]): Arranged | undefined {
  const hoisted: string[] = [];
  try {
    let index = takeShared(argv, 0, hoisted);
    const command = argv[index];
    if (command !== "hooks" && command !== "on") return undefined;
    const path: string[] = [command];
    index += 1;
    if (command === "hooks") {
      index = takeShared(argv, index, hoisted);
      const verb = argv[index];
      if (verb !== undefined && (VERBS as readonly string[]).includes(verb)) {
        path.push(verb);
        index += 1;
      }
    }
    return { path, hoisted, rest: argv.slice(index) };
  } catch (error) {
    if (error instanceof SharedValueMissing) return undefined;
    throw error;
  }
}

export function routeLabel(argv: readonly string[]): string | undefined {
  const arranged = arrange(argv);
  return arranged === undefined ? undefined : arranged.path.join(" ");
}

