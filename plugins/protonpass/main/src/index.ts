import { defineCredentialProvider } from "@ardia/plugin-sdk/credentials";
import { provider } from "./provider";

void defineCredentialProvider(provider);
