import { definePlugin } from "@ardia/plugin-sdk";
import { CommandLineStatus } from "./status";

void definePlugin({
  views: { status: CommandLineStatus },
});
