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
