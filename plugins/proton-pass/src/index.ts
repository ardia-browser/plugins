import { ardia, definePlugin } from "@ardia/plugin-sdk";
import { createPlugin } from "./plugin";

void definePlugin(createPlugin(ardia));
