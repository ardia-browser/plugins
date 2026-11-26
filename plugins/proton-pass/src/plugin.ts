import type { Ardia, PluginDefinition } from "@ardia/plugin-sdk";
import { createCredentialProvider, type CredentialProviderOptions } from "@ardia-plugins/credential-provider";
import { protonPass } from "./provider";
import { CLI, INFO } from "./spec";

export const ID = "@ardia/proton-pass";

export const createPlugin = (ardia: Ardia, overrides: Partial<CredentialProviderOptions> = {}): PluginDefinition =>
  createCredentialProvider(ardia, { id: ID, spec: CLI, info: INFO, provider: protonPass, ...overrides });
