import fs from "node:fs";
import path from "node:path";

export type FakeKeychain = { tool: string; log: () => string[]; items: () => string[] };

export function fakeKeychain(dir: string, delay = 0): FakeKeychain {
  const store = path.join(dir, "items");
  const log = path.join(dir, "log");
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const tool = path.join(dir, "security");
  const script = [
    "#!/bin/sh",
    "IFS= read -r line",
    'eval "set -- $line"',
    "cmd=$1",
    "shift",
    'acct=""',
    'value=""',
    'while [ $# -gt 0 ]; do case "$1" in -a) acct=$2; shift 2;; -w) if [ $# -ge 2 ]; then value=$2; shift 2; else shift; fi;; *) shift;; esac; done',
    `key=$(printf %s "$acct" | /usr/bin/shasum | /usr/bin/cut -c1-40)`,
    delay > 0 ? `sleep ${delay}` : ":",
    "case $cmd in",
    `  add-generic-password) printf %s "$value" > "${store}/$key"; printf %s "$acct" > "${store}/$key.account"; echo "add $acct" >> "${log}";;`,
    `  find-generic-password) echo "find $acct" >> "${log}"; if [ -f "${store}/$key" ]; then cat "${store}/$key"; echo; else echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; fi;;`,
    `  delete-generic-password) rm -f "${store}/$key" "${store}/$key.account"; echo "delete $acct" >> "${log}";;`,
    "esac",
    "",
  ].join("\n");
  fs.writeFileSync(tool, script, { mode: 0o700 });
  return {
    tool,
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    items: () =>
      fs
        .readdirSync(store)
        .filter((entry) => entry.endsWith(".account"))
        .map((entry) => fs.readFileSync(path.join(store, entry), "utf8"))
        .sort(),
  };
}
