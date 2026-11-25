export const raw = {
  name: "fakecli",
  install: { command: "brew install fakecli", url: "https://example.com/fakecli" },
  sessionLastsSeconds: 600,
  patterns: { item: "^[A-Za-z0-9]{1,64}$" },
  env: [{ name: "FAKECLI_CLIENT", literal: "Ardia" }],
  verbs: {
    "item.list": { argv: ["list", "--format", "json"], output: { mode: "json", items: "$" } },
    "item.get": { argv: ["get", { slot: "id" }, { flag: "--field", slot: "field" }], slots: { id: { type: "id", pattern: "item" }, field: { type: "enum", values: ["username", "password"], optional: true } }, output: { mode: "lines" } },
    unlock: {
      argv: ["unlock", "--raw"],
      slots: { password: { type: "secret" } },
      env: [{ name: "FAKECLI_PASSWORD", secretSlot: "password" }],
      signIn: true,
      unlocks: { persistent: true },
      output: { mode: "lastLineSecret" },
      hints: { wrongPassword: ["invalid master password"] },
    },
    status: { argv: ["status"], slots: { session: { type: "secret", optional: true } }, env: [{ name: "FAKECLI_SESSION", secretSlot: "session" }], output: { mode: "json" } },
    create: { argv: ["create"], slots: { item: { type: "json" } }, stdin: { slot: "item", encoding: "base64" }, output: { mode: "json" } },
    edit: { argv: ["edit", { slot: "id" }, { slot: "password", prefix: "password=" }], slots: { id: { type: "id", pattern: "item" }, password: { type: "secret", optional: true } }, argvSecrets: true, output: { mode: "json" } },
    open: { argv: ["open", { flag: "--url", slot: "url" }, { flag: "--verbose", when: "verbose" }], slots: { url: { type: "url", allowLocalHttp: true }, verbose: { type: "flag" } }, output: { mode: "lines" } },
    slow: { argv: ["slow"], timeoutMs: 1000, output: { mode: "lines" } },
    login: { argv: ["login"], signIn: true, unlocks: true, outlivesCall: true, timeoutMs: 20000, output: { mode: "stream" } },
  },
};

export const fakeCliScript = `#!/usr/bin/env node
const [command, ...rest] = process.argv.slice(2);
const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);
if (process.env.FAKECLI_CLIENT !== "Ardia") { err("missing client env\\n"); process.exit(9); }
switch (command) {
  case "list":
    out(JSON.stringify([{ id: "a1", title: "One" }, { id: "b2", title: "Two" }]));
    break;
  case "get":
    out(rest.join(" ") + "\\n");
    break;
  case "unlock":
    if (process.env.FAKECLI_PASSWORD !== "correct horse") { err("Invalid master password: " + process.env.FAKECLI_PASSWORD + "\\n"); process.exit(1); }
    out("Your vault is unlocked\\nsessionkey0123456789abcdef\\n");
    break;
  case "status":
    out(JSON.stringify({ session: process.env.FAKECLI_SESSION ?? null }));
    break;
  case "create": {
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => out(JSON.stringify(JSON.parse(Buffer.from(input, "base64").toString("utf8")))));
    break;
  }
  case "slow":
    setTimeout(() => out("done\\n"), 10000);
    break;
  case "login":
    out("Open https://example.com/approve?code=1 to sign in\\n");
    setTimeout(() => { out("Signed in\\n"); process.exit(0); }, 300);
    break;
  default:
    err("unknown command " + command + "\\n");
    process.exit(2);
}
`;
