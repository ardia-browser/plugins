import { defineCredentialProvider } from "@ardia/plugin-sdk/credentials";
import { bitwarden } from "./provider";

void defineCredentialProvider(bitwarden);
