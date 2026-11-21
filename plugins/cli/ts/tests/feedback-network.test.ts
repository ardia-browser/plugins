import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROGRAM = process.env.ARDIA_TS_CLI ?? path.join(TS, "dist", "ardia-ts");
const CALLER = Buffer.from(JSON.stringify({ name: "test" })).toString("hex");

type Behaviour = (socket: import("node:net").Socket, request: string) => void;

async function serve(behaviour: Behaviour): Promise<[Server, number]> {
  const server = createServer((socket) => {
    let seen = "";
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      if (seen.includes("\r\n\r\n")) behaviour(socket, seen);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return [server, (server.address() as import("node:net").AddressInfo).port];
}

async function feedback(port: number, home: string): Promise<{ status: number | null; out: string }> {
  const script = `exec "$0" --ardia-routed=2:0:3:${CALLER} feedback --title "click did nothing" "the button stayed the same" 3< <(sleep 30)`;
  const child = spawn("/bin/bash", ["-c", script, PROGRAM], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: home, ARDIA_CLI_HOME: path.join(home, "cli"), ARDIA_DATA_DIR: path.join(home, "data"), ARDIA_FEEDBACK_URL: `http://127.0.0.1:${port}` },
  });
  let out = "";
  child.stdout?.on("data", (chunk) => (out += chunk));
  const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { status, out };
}

function slots(home: string): unknown {
  const usage = JSON.parse(fs.readFileSync(path.join(home, "cli", "Usage", "usage.json"), "utf8"));
  return usage.feedback;
}

for (const [name, behaviour] of [
  ["closes in the middle of the answer", (socket) => {
    socket.write("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n{\"id\": \"FB-AB");
    setTimeout(() => socket.destroy(), 20);
  }],
  ["closes in the middle of a refusal", (socket) => {
    socket.write("HTTP/1.1 500 Oops\r\nContent-Length: 400\r\n\r\n{\"message\": \"no");
    setTimeout(() => socket.destroy(), 20);
  }],
  ["closes without answering", (socket) => socket.destroy()],
] as [string, Behaviour][]) {
  test(`a feedback service that ${name} leaves the report kept and the slot free`, async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-feedback-")));
    fs.mkdirSync(path.join(home, "data"));
    const [server, port] = await serve(behaviour);
    try {
      const { status, out } = await feedback(port, home);
      assert.equal(status, 1, out);
      assert.match(out, /^Not sent: .*It's kept on this Mac: /);
      assert.deepEqual(slots(home), []);
      assert.equal(fs.readFileSync(path.join(home, "cli", "Usage", "feedback.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
