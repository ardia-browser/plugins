import { settleReaction } from "../changes/observe.ts";
import { hooks } from "../commands/index.ts";
import { installInput } from "../input/input.ts";
import { drainCleanups } from "./drag.ts";
import { restoreAllMetrics } from "./pointer.ts";

installInput();
hooks.before = (ctx, name, argv) => settleReaction(ctx.state, name, argv);
hooks.afterCommand = (state) => restoreAllMetrics(state);
hooks.shutdown = async () => {
  await drainCleanups();
};
