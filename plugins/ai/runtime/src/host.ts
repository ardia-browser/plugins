// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import type { Channel } from "./channel.ts";

export type PluginValues = Record<string, string | boolean>;

export type ArdiaHostHandle = {
  channel: Channel;
  pluginDir: string;
  dataDir: string;
  workspaceDir: string;
  port: number;
  values: PluginValues;
  appVersion: string;
};

let current: ArdiaHostHandle | null = null;

export function setArdiaHost(handle: ArdiaHostHandle) {
  current = handle;
}

export function ardiaHost(): ArdiaHostHandle | null {
  return current;
}

export function setPluginValues(values: PluginValues) {
  if (current) current.values = values;
}
