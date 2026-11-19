import path from "node:path";
import { loadLibc } from "../src/libc.ts";

export const BUILT_LIBC = process.env.ARDIA_TEST_LIBC ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "dist", "ardia-libc.so");

loadLibc(BUILT_LIBC);
