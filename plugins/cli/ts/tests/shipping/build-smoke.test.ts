import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTarGz, type ListedMember } from "./tar-listing.ts";

const CLI = path.resolve(import.meta.dir, "..", "..", "..");
const WORKFLOWS = path.resolve(CLI, "..", "..", ".github", "workflows");
const PINNED_BUN = "1.3.14";
const APPLE_SILICON = process.platform === "darwin" && process.arch === "arm64";
const PACKS_HERE = APPLE_SILICON || (process.platform === "linux" && process.arch === "x64");

function commandExists(name: string): boolean {
  return spawnSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

function pinnedBun(): boolean {
  const bun = spawnSync("/bin/sh", ["-c", "command -v bun || echo $HOME/.bun/bin/bun"], { encoding: "utf8" }).stdout.trim();
  return spawnSync(bun, ["--version"], { encoding: "utf8", timeout: 30_000 }).stdout?.trim() === PINNED_BUN;
}

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ardia-build-smoke-"));
}

describe("scripts/build.sh", () => {
  test("the packaging smoke runs leave no history or telemetry behind", () => {
    const lines = fs.readFileSync(path.join(CLI, "scripts", "build.sh"), "utf8").split("\n");
    const runs = lines
      .map((line) => line.trimStart())
      .filter((line) => line.includes('"$root/bin/ardia"') && !/^(cp |chmod |--out )/.test(line) && !line.includes("--version"));
    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) expect(line).toMatch(/^ARDIA_CLI_HOME="\$work\/[^"]+" ARDIA_TELEMETRY=off "\$root\/bin\/ardia" /);
  });

  test.skipIf(!APPLE_SILICON)("a missing or other bun stops the build before any download", () => {
    const dir = scratch();
    try {
      const home = path.join(dir, "home");
      const fake = path.join(dir, "bin");
      fs.mkdirSync(home);
      fs.mkdirSync(fake);
      const env = { HOME: home, PATH: `${fake}:/usr/bin:/bin`, LANG: "en_US.UTF-8" };
      for (const [version, words] of [[null, "no bun on PATH"], ["1.2.0", "is 1.2.0"]] as const) {
        if (version !== null) fs.writeFileSync(path.join(fake, "bun"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
        const started = performance.now();
        const done = spawnSync("sh", [path.join(CLI, "scripts", "build.sh"), "9.9.9", path.join(dir, "out")], { env, encoding: "utf8", timeout: 60_000 });
        expect(done.status).toBe(1);
        expect(done.stderr).toContain(`builds with Bun ${PINNED_BUN}`);
        expect(done.stderr).toContain(words);
        expect(performance.now() - started).toBeLessThan(5000);
        const out = path.join(dir, "out");
        expect(fs.existsSync(out) && fs.readdirSync(out).length > 0).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plugins/cli/build.sh", () => {
  test.skipIf(!(PACKS_HERE && commandExists("npm") && pinnedBun()))(
    "ARDIA_SIGN_CMD signs the folder both tarballs are packed from, and a failing one packs nothing",
    () => {
      const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
      const names = [`ardia-cli-7.7.7-${platform}.tar.gz`, `cli-7.7.7-${platform}.tar.gz`];
      const dir = scratch();
      try {
        const sign = path.join(dir, "sign.sh");
        fs.writeFileSync(
          sign,
          [
            "#!/bin/sh",
            "set -eu",
            '[ -f "$1/plugin.json" ] && [ -f "$1/dist/index.js" ] || { echo "the folder isn\'t complete" >&2; exit 1; }',
            'for packed in "$(dirname "$1")"/cli-*.tar.gz; do [ ! -e "$packed" ] || { echo "packed before signing" >&2; exit 1; }; done',
            "for macho in bin/ardia bin/ardia-libc.so libexec/esbuild; do printf '%s\\n' \"$macho\" >>\"$(dirname \"$1/$macho\")/signed-by-test\"; done",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "ARDIA_SIGN_CMD")) as Record<string, string>;
        const build = (out: string, extra: Record<string, string> = {}): Record<string, ListedMember[]> => {
          const done = spawnSync("sh", [path.join(CLI, "build.sh"), path.join(dir, out)], {
            env: { ...baseEnv, ARDIA_PLUGIN_VERSION: "7.7.7", ...extra },
            encoding: "utf8",
            timeout: 600_000,
          });
          expect(done.status, done.stderr).toBe(0);
          const listed: Record<string, ListedMember[]> = {};
          for (const name of names) {
            const tarball = fs.readFileSync(path.join(dir, out, name));
            const digest = createHash("sha256").update(tarball).digest("hex");
            expect(fs.readFileSync(path.join(dir, out, `${name}.sha256`), "utf8").split(/\s+/)[0]).toBe(digest);
            listed[name] = listTarGz(tarball);
          }
          return listed;
        };
        const plain = build("plain");
        const signed = build("signed", { ARDIA_SIGN_CMD: `"${sign}" "$1"` });
        const key = (member: ListedMember) => JSON.stringify(member);
        for (const name of names) {
          const markers = (signed[name] ?? []).filter((member) => member.name.endsWith("/signed-by-test"));
          expect(markers.map((member) => member.name.split("/").slice(1).join("/")).sort()).toEqual(["bin/signed-by-test", "libexec/signed-by-test"]);
          expect((signed[name] ?? []).filter((member) => !markers.includes(member)).map(key)).toEqual((plain[name] ?? []).map(key));
          expect((plain[name] ?? []).filter((member) => member.name.includes("signed-by-test"))).toEqual([]);
        }
        const refused = path.join(dir, "refused");
        const failing = spawnSync("sh", [path.join(CLI, "build.sh"), refused], {
          env: { ...process.env, ARDIA_PLUGIN_VERSION: "7.7.7", ARDIA_SIGN_CMD: "exit 3" },
          encoding: "utf8",
          timeout: 600_000,
        });
        expect(failing.status).toBe(1);
        expect(failing.stderr).toContain("ARDIA_SIGN_CMD failed");
        expect(fs.readdirSync(refused).filter((entry) => entry.endsWith(".tar.gz") || entry.endsWith(".sha256"))).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    1_500_000,
  );
});

describe("release workflows", () => {
  test("every release job that runs build.sh sets up the pinned bun first", () => {
    const pinned = /uses: (oven-sh\/setup-bun@[0-9a-f]{40})\n\s+with:\n\s+bun-version: 1\.3\.14\n/.exec(fs.readFileSync(path.join(WORKFLOWS, "ci.yml"), "utf8"));
    expect(pinned).not.toBeNull();
    const action = (pinned as RegExpExecArray)[1] as string;
    const release = fs.readFileSync(path.join(WORKFLOWS, "release-plugin.yml"), "utf8");
    const jobs = (release.split("\njobs:\n")[1] ?? "").split(/\n {2}(?=[a-z][a-z-]*:\n)/);
    const building = jobs.filter((job) => job.includes("build.sh"));
    expect(building.length).toBeGreaterThan(0);
    for (const job of building) {
      expect(job).toContain(`uses: ${action}\n        with:\n          bun-version: 1.3.14\n`);
      expect(job.indexOf(action)).toBeLessThan(job.indexOf("build.sh"));
    }
  });
});
