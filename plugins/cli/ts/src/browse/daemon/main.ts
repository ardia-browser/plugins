import fs from "node:fs";
import path from "node:path";
import { isatty } from "node:tty";
import { LIBC_UNAVAILABLE, LibcUnavailable, loadLibc } from "../../libc.ts";
import { reportException } from "../../telemetry.ts";
import { registerUrlSecrets } from "../endpoint.ts";
import { PathError } from "../paths.ts";
import { seedTokens } from "../tokens.ts";
import { BadConfig, CONFIG_LIMIT, type DaemonConfig, parseConfig } from "./config.ts";
import { log } from "./log.ts";

const REFUSED = "ardia-ts daemon: the browse daemon is started by `ardia browse`, with its config on stdin\n";

async function readStdin(limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    chunks.push(bytes);
    total += bytes.length;
    if (total > limit) throw new BadConfig("the config on stdin is too large");
  }
  return Buffer.concat(chunks);
}

function writeStderr(text: string): void {
  try {
    fs.writeSync(2, text);
  } catch {}
}

export function takeLease(executable = process.execPath): string | null {
  let root: string;
  try {
    root = path.dirname(path.dirname(fs.realpathSync(executable)));
  } catch {
    return null;
  }
  const leases = path.join(root, ".leases");
  try {
    if (!fs.statSync(leases).isDirectory()) return null;
  } catch {
    return null;
  }
  const lease = path.join(leases, String(process.pid));
  try {
    fs.closeSync(fs.openSync(lease, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o644));
  } catch {
    return null;
  }
  return lease;
}

function dropLease(lease: string | null): void {
  if (lease === null) return;
  try {
    fs.unlinkSync(lease);
  } catch {}
}

export async function daemonMain(argv: string[]): Promise<number> {
  if (argv.length !== 0 || isatty(0)) {
    writeStderr(REFUSED);
    return 2;
  }
  try {
    loadLibc();
  } catch (error) {
    if (!(error instanceof LibcUnavailable)) throw error;
    writeStderr(`${error.message}\n`);
    return LIBC_UNAVAILABLE;
  }
  let config: DaemonConfig;
  try {
    config = parseConfig(new TextDecoder("utf-8", { fatal: true }).decode(await readStdin(CONFIG_LIMIT)));
  } catch (error) {
    writeStderr(`ardia-ts daemon: ${error instanceof BadConfig ? error.message : "the config on stdin isn't UTF-8 JSON"}\n`);
    return 2;
  }
  process.stdin.destroy();
  if (config.ws) registerUrlSecrets(config.ws);
  seedTokens(config.harnessSeed);
  log.configure(config.debug);
  process.on("unhandledRejection", (error) => log.exception("a background task failed", error));
  const where = { dataRoot: config.dataRoot, testEndpoint: Boolean(config.ws || config.port) };
  const lease = takeLease();
  process.once("exit", () => dropLease(lease));
  try {
    const { Daemon } = await import("./server.ts");
    const daemon = new Daemon(config);
    return await daemon.run();
  } catch (error) {
    if (error instanceof PathError) {
      log.raw(`ardia browse daemon: ${error.message}\n`);
      return 2;
    }
    reportException(error, "browse_daemon", where, true);
    log.exception("the browse daemon failed", error);
    return 1;
  } finally {
    dropLease(lease);
  }
}
