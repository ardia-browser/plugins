import { writeSync } from "node:fs";
import { callerWire, currentCaller } from "../src/caller.ts";
import { loadLibc } from "../src/libc.ts";

loadLibc();
writeSync(1, `${JSON.stringify(Object.fromEntries(callerWire(currentCaller())))}\n`);
