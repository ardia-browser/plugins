import type { CommandRoute } from "./commands-e.ts";
import { deliver, usageFailure } from "./deliver.ts";
import { Call } from "./telemetry.ts";

export async function serveCommand(route: CommandRoute, argv: string[], python: string | null): Promise<number> {
  const call = new Call(argv);
  call.command = route.command;
  call.subcommand = route.subcommand;
  call.allowedFlags = route.allowedFlags;
  if (route.usage !== undefined || route.run === undefined) return usageFailure(call, route.usage ?? "", python);
  return deliver(call, await route.run(call), route.json, python);
}
