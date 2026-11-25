import type { Ardia, PluginDefinition } from "@ardia/plugin-sdk";
import { askForKey, forgetKey } from "./key";
import { aiProvider, AI_PROVIDER } from "./provider";
import { askView } from "./view";

export const createPlugin = (ardia: Ardia): PluginDefinition => ({
  views: { ask: askView(ardia) },
  commands: {
    "set-api-key": () => askForKey(ardia),
    "forget-api-key": () => forgetKey(ardia),
  },
  services: { [AI_PROVIDER]: aiProvider(ardia) },
});
