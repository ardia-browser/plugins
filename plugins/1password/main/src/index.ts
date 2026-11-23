import { defineCredentialProvider } from "@ardia/plugin-sdk/credentials";
import { onePassword } from "./provider";

void defineCredentialProvider(onePassword);
