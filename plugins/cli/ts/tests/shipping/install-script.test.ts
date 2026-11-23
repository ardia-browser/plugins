import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INSTALL_SH = path.resolve(import.meta.dir, "..", "..", "..", "install.sh");

function commandExists(name: string): boolean {
  return spawnSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

const RUNS_HERE = process.platform === "linux" && process.arch === "x64" && commandExists("flock") && commandExists("sha256sum");
const POSIX_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const FISH_LINE = "contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH";
const FISH_FILE = ".config/fish/conf.d/ardia.fish";

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function tarUp(tarball: string, stage: string, members: string[]): void {
  const done = spawnSync("tar", ["-czf", tarball, "-C", stage, ...members], { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`tar: ${done.stderr}`);
}

function fakeTarball(folder: string, version: string): string {
  const tarball = path.join(folder, `ardia-cli-${version}-linux-x64.tar.gz`);
  const stage = fs.mkdtempSync(path.join(folder, "stage-"));
  const root = path.join(stage, `ardia-cli-${version}`);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(root, ".leases"), { mode: 0o755 });
  fs.writeFileSync(path.join(root, "bin", "ardia"), `#!/bin/sh\necho 'ardia ${version}'\n`, { mode: 0o755 });
  fs.symlinkSync("ardia", path.join(root, "bin", "python3"));
  tarUp(tarball, stage, [`ardia-cli-${version}`]);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.writeFileSync(`${tarball}.sha256`, `${sha256(tarball)}  ${path.basename(tarball)}\n`);
  return tarball;
}

class Installer {
  readonly temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-install-test-")));
  readonly dist = path.join(this.temp, "dist");
  readonly tools = path.join(this.temp, "tools");
  home = "";
  cliHome = "";
  bin = "";

  constructor() {
    fs.mkdirSync(this.dist);
    fs.mkdirSync(this.tools);
    this.useHome("home");
  }

  useHome(name: string): void {
    this.home = path.join(this.temp, name);
    fs.mkdirSync(this.home);
    this.cliHome = path.join(this.home, ".local", "share", "ardia", "cli");
    this.bin = path.join(this.home, ".local", "bin", "ardia");
  }

  loginShell(name: string): string {
    const shell = path.join(this.tools, "shells", name);
    fs.mkdirSync(path.dirname(shell), { recursive: true });
    fs.writeFileSync(shell, "#!/bin/sh\nprintf '%s' /usr/bin:/bin\n", { mode: 0o755 });
    fs.writeFileSync(path.join(this.tools, "getent"), `#!/bin/sh\necho "me:x:1000:1000::/home/me:${shell}"\n`, { mode: 0o755 });
    return shell;
  }

  install(version: string | null, args: string[] = [], options: { urlVersion?: string; env?: Record<string, string> } = {}) {
    const urlVersion = options.urlVersion ?? version ?? "";
    const tarball = path.join(this.dist, `ardia-cli-${urlVersion}-linux-x64.tar.gz`);
    if (!fs.existsSync(tarball)) fakeTarball(this.dist, urlVersion);
    const env = {
      PATH: `${this.tools}:/usr/local/bin:/usr/bin:/bin`,
      HOME: this.home,
      TMPDIR: this.temp,
      ARDIA_CLI_URL: `file://${tarball}`,
      SHELL: "/bin/sh",
      ...options.env,
    };
    const command = [INSTALL_SH, ...(version ? ["--version", version] : []), ...args];
    const done = spawnSync("/bin/sh", command, { env, encoding: "utf8", timeout: 60_000 });
    const lines = done.stdout.split("\n").filter((line) => line !== "");
    return { status: done.status, lines, stderr: done.stderr };
  }

  versions(): string[] {
    return fs
      .readdirSync(this.cliHome)
      .filter((name) => !name.startsWith(".") && name !== "current")
      .sort();
  }

  current(): string {
    return fs.readlinkSync(path.join(this.cliHome, "current"));
  }

  close(): void {
    fs.rmSync(this.temp, { recursive: true, force: true });
  }
}

describe.skipIf(!RUNS_HERE)("install.sh on Linux x86_64", () => {
  let it: Installer;
  beforeEach(() => {
    it = new Installer();
  });
  afterEach(() => it.close());

  test("installs, leaves a current version alone, upgrades, and keeps leased versions", () => {
    it.loginShell("zsh");
    let run = it.install("0.0.1");
    expect(run.status, run.stderr).toBe(0);
    expect(run.lines).toEqual(["step resolve", "version 0.0.1", "step download", "step verify", "step install", "step link", `path ${path.join(it.home, ".zprofile")}`, `installed ${it.bin}`]);
    expect(fs.readlinkSync(it.bin)).toBe(path.join(it.cliHome, "current", "bin", "ardia"));
    expect(it.current()).toBe("0.0.1");
    expect(spawnSync(it.bin, { encoding: "utf8" }).stdout.trim()).toBe("ardia 0.0.1");
    expect(fs.readFileSync(path.join(it.home, ".zprofile"), "utf8")).toBe(`${POSIX_LINE}\n`);

    run = it.install("0.0.1");
    expect([run.status, run.lines]).toEqual([0, ["step resolve", "version 0.0.1", `installed ${it.bin}`]]);

    const digest = sha256(fakeTarball(it.dist, "0.0.2"));
    run = it.install("0.0.2", ["--sha256", digest]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.lines).toEqual(["step resolve", "version 0.0.2", "step download", "step verify", "step install", `installed ${it.bin}`]);
    expect([it.current(), it.versions()]).toEqual(["0.0.2", ["0.0.1", "0.0.2"]]);
    expect(fs.readFileSync(path.join(it.home, ".zprofile"), "utf8").split("export PATH").length - 1).toBe(1);

    run = it.install("0.0.3");
    expect(run.status, run.stderr).toBe(0);
    expect([it.current(), it.versions()]).toEqual(["0.0.3", ["0.0.2", "0.0.3"]]);

    const lease = path.join(it.cliHome, "0.0.2", ".leases", String(process.pid));
    fs.writeFileSync(lease, "");
    const dead = spawnSync("true");
    fs.writeFileSync(path.join(it.cliHome, "0.0.3", ".leases", String(dead.pid)), "");
    run = it.install("0.0.4");
    expect(run.status, run.stderr).toBe(0);
    expect([it.current(), it.versions()]).toEqual(["0.0.4", ["0.0.2", "0.0.3", "0.0.4"]]);
    fs.unlinkSync(lease);
    run = it.install("0.0.5");
    expect(run.status, run.stderr).toBe(0);
    expect([it.current(), it.versions()]).toEqual(["0.0.5", ["0.0.4", "0.0.5"]]);
    expect(fs.statSync(path.join(it.cliHome, ".lock")).isFile()).toBe(true);

    run = it.install(null, ["--uninstall"]);
    expect([run.status, run.lines]).toEqual([0, ["step uninstall", "uninstalled"]]);
    expect(fs.existsSync(it.bin) || fs.lstatSync(it.bin, { throwIfNoEntry: false }) !== undefined).toBe(false);
    expect(fs.readdirSync(it.cliHome).sort()).toEqual([".lock"]);
  });

  test("takes the version from the URL and installs under XDG_DATA_HOME, ignoring a relative one", () => {
    it.loginShell("zsh");
    const data = path.join(it.temp, "xdg-data");
    let run = it.install(null, [], { urlVersion: "0.0.7", env: { XDG_DATA_HOME: data } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.lines).toContain("version 0.0.7");
    expect(fs.readlinkSync(path.join(data, "ardia", "cli", "current"))).toBe("0.0.7");
    expect(fs.readlinkSync(it.bin)).toBe(path.join(data, "ardia", "cli", "current", "bin", "ardia"));
    it.useHome("home-relative");
    it.loginShell("zsh");
    run = it.install("0.0.7", [], { env: { XDG_DATA_HOME: "relative/data" } });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readlinkSync(path.join(it.cliHome, "current"))).toBe("0.0.7");
  });

  test("writes the PATH line to each shell's login file, once", () => {
    const cases: [string, string | null, string, string][] = [
      ["zsh", null, ".zprofile", POSIX_LINE],
      ["bash", null, ".profile", POSIX_LINE],
      ["bash", ".bash_profile", ".bash_profile", POSIX_LINE],
      ["fish", null, FISH_FILE, FISH_LINE],
      ["fish", FISH_FILE, FISH_FILE, FISH_LINE],
      ["sh", null, ".profile", POSIX_LINE],
    ];
    cases.forEach(([shell, existing, expected, line], index) => {
      it.useHome(`home-${index}`);
      it.loginShell(shell);
      if (existing) {
        fs.mkdirSync(path.dirname(path.join(it.home, existing)), { recursive: true });
        fs.writeFileSync(path.join(it.home, existing), "# mine");
      }
      let run = it.install("0.0.1");
      expect(run.status, `${shell} ${existing}: ${run.stderr}`).toBe(0);
      expect(run.lines).toContain(`path ${path.join(it.home, expected)}`);
      expect(fs.readFileSync(path.join(it.home, expected), "utf8").endsWith(existing ? `\n${line}\n` : `${line}\n`)).toBe(true);
      if (shell === "fish") {
        expect(fs.existsSync(path.join(it.home, ".profile"))).toBe(false);
        run = it.install("0.0.2");
        expect(run.status, run.stderr).toBe(0);
        expect(fs.readFileSync(path.join(it.home, expected), "utf8").split(line).length - 1).toBe(1);
      }
    });
  });

  test("fish follows an absolute XDG_CONFIG_HOME and ignores a relative one", () => {
    it.loginShell("fish");
    let run = it.install("0.0.1", [], { env: { XDG_CONFIG_HOME: path.join(it.temp, "xdg") } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.lines).toContain(`path ${path.join(it.temp, "xdg", "fish", "conf.d", "ardia.fish")}`);
    run = it.install("0.0.2", [], { env: { XDG_CONFIG_HOME: "relative" } });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.statSync(path.join(it.home, ".config", "fish", "conf.d", "ardia.fish")).isFile()).toBe(true);
  });

  test("writes no PATH line when the login PATH has the bin dir", () => {
    const shell = it.loginShell("bash");
    fs.writeFileSync(shell, '#!/bin/sh\nprintf \'%s\' "/usr/bin:$HOME/.local/bin"\n', { mode: 0o755 });
    const run = it.install("0.0.1");
    expect(run.status, run.stderr).toBe(0);
    expect(run.lines.filter((line) => line.startsWith("path "))).toEqual([]);
    expect(fs.existsSync(path.join(it.home, ".profile"))).toBe(false);
  });

  test("a custom bin dir skips the PATH line", () => {
    it.loginShell("zsh");
    const binDir = path.join(it.temp, "bin");
    const run = it.install("0.0.1", [], { env: { ARDIA_CLI_BIN_DIR: binDir } });
    expect(run.status, run.stderr).toBe(0);
    expect(run.lines.at(-1)).toBe(`installed ${path.join(binDir, "ardia")}`);
    expect(run.lines.some((line) => line.startsWith("path "))).toBe(false);
  });

  test("refuses an ardia that isn't its own link", () => {
    it.loginShell("zsh");
    fs.mkdirSync(path.dirname(it.bin), { recursive: true });
    fs.writeFileSync(it.bin, "#!/bin/sh\n");
    const run = it.install("0.0.1");
    expect(run.status).toBe(1);
    expect(run.lines.at(-1)).toBe(`error ${it.bin} already exists and isn't this CLI's link; move it away and run this again`);
    expect(fs.existsSync(it.cliHome)).toBe(false);
  });

  test("a checksum mismatch installs nothing", () => {
    it.loginShell("zsh");
    const run = it.install("0.0.1", ["--sha256", "0".repeat(64)]);
    expect(run.status).toBe(1);
    expect(run.lines.at(-1)?.startsWith(`error checksum mismatch: expected ${"0".repeat(64)}`)).toBe(true);
    expect(fs.existsSync(path.join(it.cliHome, "current"))).toBe(false);
  });

  test("a download needs a pinned digest", () => {
    const run = it.install("0.0.1", [], { env: { ARDIA_CLI_URL: "" } });
    expect(run.status).toBe(1);
    expect(run.lines.at(-1)?.startsWith("error no --sha256")).toBe(true);
  });

  test("refuses a tarball with links that point outside it", () => {
    it.loginShell("zsh");
    const tarball = path.join(it.dist, "ardia-cli-0.0.9-linux-x64.tar.gz");
    const stage = fs.mkdtempSync(path.join(it.temp, "stage-"));
    fs.mkdirSync(path.join(stage, "ardia-cli-0.0.9", "bin"), { recursive: true });
    fs.symlinkSync("/bin/sh", path.join(stage, "ardia-cli-0.0.9", "bin", "ardia"));
    tarUp(tarball, stage, ["ardia-cli-0.0.9/bin/ardia"]);
    fs.writeFileSync(`${tarball}.sha256`, `${sha256(tarball)}\n`);
    const run = it.install("0.0.9");
    expect([run.status, run.lines.at(-1)]).toEqual([1, "error the tarball has links that point outside it"]);
  });
});
