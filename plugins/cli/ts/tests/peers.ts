import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PERL = "/usr/bin/perl";

const HOLD_LOCK = [
  "use Fcntl qw(:flock O_RDWR O_CREAT);",
  "sysopen(my $fh, $ARGV[0], O_RDWR | O_CREAT, 0600) or die \"open: $!\";",
  "flock($fh, LOCK_EX) or die \"flock: $!\";",
  "$| = 1;",
  "print \"held\\n\";",
  "my $rest = do { local $/; <STDIN> };",
].join("\n");

const STALE_SOCKET = [
  "use Socket;",
  "umask 0177;",
  "socket(my $s, PF_UNIX, SOCK_STREAM, 0) or die \"socket: $!\";",
  "bind($s, pack_sockaddr_un($ARGV[0])) or die \"bind: $!\";",
  "close $s;",
].join("\n");



function ready(child: ChildProcess, word: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the peer never said ${word}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes(word)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the peer exited (${code}) before saying ${word}`));
    });
  });
}

export async function lockHolder(file: string): Promise<{ release(): void; exited: Promise<void> }> {
  const child = spawn(PERL, ["-e", HOLD_LOCK, file], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const release = () => {
    child.stdin?.end();
    child.kill();
  };
  process.once("exit", release);
  await ready(child, "held", 10_000);
  return { release, exited };
}

export function staleSocket(file: string): void {
  const done = spawnSync(PERL, ["-e", STALE_SOCKET, file], { encoding: "utf8", timeout: 10_000 });
  if (done.status !== 0) throw new Error(`staleSocket: ${done.stderr}`);
}

const STALLING_SERVER = `
const net = require("node:net");
const [where, delayMs, payloadBytes] = process.argv.slice(2);
const server = net.createServer((client) => {
  client.pause();
  setTimeout(() => client.write(Buffer.concat([Buffer.alloc(Number(payloadBytes), 0x5b), Buffer.alloc(Number(payloadBytes), 0x5d), Buffer.from("\\n")])), Number(delayMs));
  setTimeout(() => process.exit(0), 20_000);
});
server.listen(where, () => process.stdout.write("ready\\n"));
`;

export async function stallingNestedReplyServer(where: string, delayMs: number, depth: number): Promise<{ stop(): void }> {
  const script = path.join(path.dirname(where), "stalling-server.js");
  fs.writeFileSync(script, STALLING_SERVER);
  const child = spawn(process.execPath, [script, where, String(delayMs), String(depth)], { stdio: ["ignore", "pipe", "inherit"] });
  const stop = () => child.kill("SIGKILL");
  process.once("exit", stop);
  await ready(child, "ready", 10_000);
  return { stop };
}
