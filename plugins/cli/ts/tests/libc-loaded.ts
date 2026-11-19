import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLibc } from "../src/libc.ts";

export const BUILT_LIBC = process.env.ARDIA_TEST_LIBC ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "ardia-libc.so");

loadLibc(BUILT_LIBC);
