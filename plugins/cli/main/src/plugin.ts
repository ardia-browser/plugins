import type { Ardia, PluginDefinition } from "@ardia/plugin-sdk";
import { statusView } from "./status";

export const createPlugin = (ardia: Ardia): PluginDefinition => ({
  views: { status: statusView(ardia) },
});
