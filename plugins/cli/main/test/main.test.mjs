import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
const hello = { app: "Ardia", version: "0.2.48", protocol: 2, plugin: "cli", values: {} };
const WAIT_MS = 8000;

const linked = { state: "linked", linked: ["ardia"], failed: [], binDir: "/Users/someone/.local/bin" };
const failed = { state: "failed", linked: [], failed: [{ name: "ardia", reason: "~/.local/bin/ardia is someone else's; remove it to use this one" }], binDir: "/Users/someone/.local/bin" };
const linking = { state: "linking", linked: [], failed: [], binDir: null };

function inVm(onLine) {
  let deliver = () => {};
  const bridge = { send: (line) => onLine(line), onLine: (listener) => (deliver = listener) };
  const context = vm.createContext({ __ardiaBridge: bridge, setTimeout, clearTimeout, queueMicrotask, console });
  vm.runInContext(readFileSync(`${distDir}index.js`, "utf8"), context, { filename: "index.js" });
  return { deliver: (line) => deliver(line), stop: () => {}, problems: () => "" };
}

function inHost(binary) {
  return (onLine) => {
    const child = spawn(binary, ["--entry", "index.js"], { cwd: distDir, stdio: ["ignore", "ignore", "pipe", "pipe"], env: { ARDIA_PLUGIN_FD: "3" } });
    let stderr = "";
    let pending = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const channel = child.stdio[3];
    channel.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line) onLine(line);
      }
    });
    let stopped = false;
    channel.on("error", (error) => {
      if (!stopped) stderr += String(error);
    });
    return {
      deliver: (line) => stopped || channel.write(`${line}\n`),
      stop: () => {
        stopped = true;
        child.kill("SIGKILL");
      },
      problems: () => stderr,
    };
  };
}

function fakeHost(start, replies) {
  const sent = [];
  const waiters = new Set();
  let transport = null;
  const answer = (message) => {
    const reply = replies[message.method];
    setImmediate(async () => {
      try {
        const result = typeof reply === "function" ? await reply(message.params) : reply === undefined ? { ok: true } : reply;
        transport.deliver(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        transport.deliver(JSON.stringify({ id: message.id, error: { code: "refused", message: error.message } }));
      }
    });
  };
  transport = start((line) => {
    const message = JSON.parse(line);
    sent.push(message);
    if (typeof message.method === "string" && message.id !== undefined) answer(message);
    for (const wake of waiters) wake();
  });
  const until = (find, what) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = find();
        if (!found) return;
        waiters.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timed out waiting for ${what}${transport.problems() ? `\n${transport.problems()}` : ""}`));
      }, WAIT_MS);
      waiters.add(check);
      check();
    });
  return {
    sent,
    until,
    calls: (method) => sent.filter((message) => message.method === method),
    renders: (surfaceId) => sent.filter((message) => message.method === "surface.render" && message.params.surfaceId === surfaceId).map((message) => message.params.tree),
    push: (message) => transport.deliver(JSON.stringify(message)),
    stop: () => transport.stop(),
  };
}

function nodes(tree, found = []) {
  if (!tree || typeof tree !== "object") return found;
  if (typeof tree.type === "string") found.push(tree);
  for (const child of tree.children ?? []) nodes(child, found);
  for (const value of Object.values(tree.props ?? {})) if (value && typeof value === "object" && "type" in value) nodes(value, found);
  return found;
}

const actionTitled = (tree, title) => nodes(tree).find((node) => node.props?.title === title);
const copying = (tree, content) => nodes(tree).find((node) => node.type === "Action" && node.props?.copy === content);

async function shown(host, surfaceId, predicate, what) {
  return host.until(() => host.renders(surfaceId).findLast((tree) => tree.type === "Detail" && !tree.props.isLoading && predicate(tree)), what);
}

async function openStatus(start, replies) {
  const host = fakeHost(start, { hello, ...replies });
  const ready = await host.until(() => host.calls("ready")[0], "ready");
  host.push({ surface: "mount", surfaceId: "s1", viewId: "status", kind: "command", context: {} });
  return { host, ready };
}

const transports = [["a Node vm", inVm]];
if (process.env.ARDIA_PLUGIN_HOST) transports.push(["ArdiaPluginHost", inHost(process.env.ARDIA_PLUGIN_HOST)]);

for (const [where, start] of transports) {
  describe(`dist/index.js in ${where}`, () => {
    test("registers the view every manifest command opens, and no commands of its own", async () => {
      const { host, ready } = await openStatus(start, { "programs.status": linked });
      try {
        const views = manifest.contributes.commands.map((command) => command.view);
        assert.ok(views.length > 0);
        for (const view of views) assert.ok(ready.params.views.includes(view), view);
        assert.deepEqual(ready.params.commands, []);
      } finally {
        host.stop();
      }
    });

    test("a linked ardia shows where it is and the example with Copy, and offers no Try Again", async () => {
      const { host } = await openStatus(start, { "programs.status": linked });
      try {
        const tree = await shown(host, "s1", (t) => t.props.markdown.includes("is on your PATH"), "the linked status");
        assert.match(tree.props.markdown, /\/Users\/someone\/\.local\/bin\/ardia/);
        assert.ok(copying(tree, "ardia tabs"), "Copy Example");
        assert.ok(copying(tree, "/Users/someone/.local/bin/ardia"), "Copy Location");
        assert.equal(actionTitled(tree, "Try Again"), undefined);
        assert.deepEqual(
          tree.props.metadata.map((row) => row.label),
          ["Command", "Status", "Location", "Try"],
        );
        assert.equal(host.calls("programs.relink").length, 0);
      } finally {
        host.stop();
      }
    });

    test("a failed link shows the reason, and Try Again relinks and shows the result", async () => {
      let state = failed;
      const { host } = await openStatus(start, {
        "programs.status": () => state,
        "programs.relink": () => {
          state = linked;
          return { ok: true };
        },
      });
      try {
        const tree = await shown(host, "s1", (t) => t.props.markdown.includes("isn't on your PATH"), "the failed status");
        assert.match(tree.props.markdown, /someone else's/);
        const tryAgain = actionTitled(tree, "Try Again");
        assert.ok(tryAgain, "Try Again");
        host.push({ surface: "event", surfaceId: "s1", handlerId: tryAgain.props.onAction.__handler, args: [] });
        await shown(host, "s1", (t) => t.props.markdown.includes("is on your PATH"), "the status after Try Again");
        assert.equal(host.calls("programs.relink").length, 1);
      } finally {
        host.stop();
      }
    });

    test("a refused Try Again says why and keeps Try Again", async () => {
      const { host } = await openStatus(start, {
        "programs.status": failed,
        "programs.relink": () => {
          throw new Error("A link is already under way.");
        },
      });
      try {
        const tree = await shown(host, "s1", (t) => Boolean(actionTitled(t, "Try Again")), "Try Again");
        host.push({ surface: "event", surfaceId: "s1", handlerId: actionTitled(tree, "Try Again").props.onAction.__handler, args: [] });
        const after = await shown(host, "s1", (t) => t.props.markdown.includes("already under way"), "the refusal");
        assert.ok(actionTitled(after, "Try Again"));
      } finally {
        host.stop();
      }
    });

    test("while Ardia is linking, the view checks again until it's done", async () => {
      let asked = 0;
      const { host } = await openStatus(start, { "programs.status": () => (++asked < 3 ? linking : linked) });
      try {
        await shown(host, "s1", (t) => t.props.markdown.includes("is on your PATH"), "the status after linking");
        assert.ok(asked >= 3);
      } finally {
        host.stop();
      }
    });

    test("a slow Ardia never gets a second status check while the first is still waiting", async () => {
      let asked = 0;
      let waiting = 0;
      let mostAtOnce = 0;
      const slow = async () => {
        waiting += 1;
        mostAtOnce = Math.max(mostAtOnce, waiting);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        waiting -= 1;
        return ++asked < 3 ? linking : linked;
      };
      const { host } = await openStatus(start, { "programs.status": slow });
      try {
        await shown(host, "s1", (t) => t.props.markdown.includes("is on your PATH"), "the status after a slow link");
        assert.equal(mostAtOnce, 1);
      } finally {
        host.stop();
      }
    });

    test("an Ardia that can't answer is said so, with Check Again", async () => {
      const { host } = await openStatus(start, {
        "programs.status": () => {
          throw new Error("programs.status isn't a method this Ardia knows.");
        },
      });
      try {
        const tree = await shown(host, "s1", (t) => t.props.markdown.includes("Couldn't ask Ardia"), "the unreachable state");
        assert.ok(actionTitled(tree, "Check Again"));
        assert.ok(copying(tree, "ardia tabs"));
      } finally {
        host.stop();
      }
    });
  });
}
