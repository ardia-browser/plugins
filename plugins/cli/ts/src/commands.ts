import { type Command, serveCommand } from "./cli-command.ts";

export async function serve(command: Command, python: string | null): Promise<number | undefined> {
  if (command.group === "config") {
    const { runConfig } = await import("./config-cli.ts");
    return serveCommand(command, (args, io) => runConfig(command.verb, args, io), python);
  }
  if (command.group === "theme") {
    const { runTheme } = await import("./theme-cli.ts");
    return serveCommand(command, (args, io) => runTheme(command.verb, args, io), python);
  }
  const { runPlugins } = await import("./plugins-cli.ts");
  return serveCommand(command, (args, io) => runPlugins(command.verb, args, io), python);
}
