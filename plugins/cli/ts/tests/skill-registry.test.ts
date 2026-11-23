import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ERROR_CODES, COMMAND_SLOT } from "../src/browse/remedies.ts";
import { COMMAND_FLAGS, KNOWN_COMMANDS } from "../src/browse/tables.ts";
import { checkCommand, checkExamples, examplesIn, shellWords } from "../src/skill-examples.ts";
import { SKILL_FILES } from "../src/skill-files.ts";
import { browseCommands, COMMANDS_FILE, generated, replaceSection, stale } from "../src/skill-gen.ts";

test("SKILL.md, references/commands.md and the error code table match the command registry", () => {
  expect(stale(), "run `bun src/skill-gen.ts --write` in plugins/cli/ts").toEqual([]);
  expect(SKILL_FILES.map(([name]) => name)).toContain(COMMANDS_FILE);
});

test("every ardia example in the skill parses with the real CLI parsers", () => {
  const { examples, problems } = checkExamples(SKILL_FILES);
  expect(examples.length).toBeGreaterThan(150);
  expect(problems.map(({ example, problem }) => `${example.file}:${example.line}: ${example.text}: ${problem}`)).toEqual([]);
});

test("the checker catches unknown commands, flags, launch options and bad batch lines", () => {
  expect(checkCommand("ardia browse clik @e1")[0]).toContain("did you mean `click`");
  expect(checkCommand("ardia browse snapshot -x")[0]).toContain("doesn't take -x");
  expect(checkCommand("ardia browse read --linkz /p/")[0]).toContain("--links");
  expect(checkCommand("ardia browse --headed open x")[0]).toContain("--headed");
  expect(checkCommand("ardia browse connect 9222")[0]).toContain("isn't part of ardia browse");
  expect(checkCommand("ardia tabs --usagee")[0]).toContain("unrecognized arguments");
  expect(checkCommand("ardia frob")[0]).toContain("unknown command");
  expect(checkCommand(`ardia browse batch "click @e1" "fil @e2 x"`)[0]).toContain("fil");
  for (const good of ["ardia browse goto example.com", "ardia --port 9222 browse snapshot -i", "ardia call run -p command=newTab", "ardia skills status", "ardia browse perf insight --reload --crux", "ardia browse <command> --help"]) {
    expect(checkCommand(good), good).toEqual([]);
  }
});

test("examples come from fenced blocks, batch heredocs and inline spans that wrap lines", () => {
  const text = ["Run `ardia browse", "snapshot -i` first.", "", "```sh", "ardia browse batch <<'EOF'", "click @e1", "# a comment", "fil @e2 x", "EOF", "ardia browse script <<'EOF'", "const x = 1;", "EOF", "```"].join("\n");
  const found = examplesIn("x.md", text);
  expect(found.map((example) => [example.line, example.text, example.batch])).toEqual([
    [1, "ardia browse snapshot -i", false],
    [5, "ardia browse batch <<'EOF'", false],
    [6, "click @e1", true],
    [8, "fil @e2 x", true],
    [10, "ardia browse script <<'EOF'", false],
  ]);
  expect(checkExamples([["x.md", text]]).problems.map(({ problem }) => problem)).toEqual([expect.stringContaining("unknown command `fil`")]);
  expect(shellWords(`ardia browse fill @e3 "Ana Ruiz" # note`)).toEqual(["ardia", "browse", "fill", "@e3", "Ana Ruiz"]);
  expect(shellWords("ardia tabs --json | jq .")).toEqual(["ardia", "tabs", "--json"]);
});

test("every remedy is a command the CLI takes, for every command it can name", () => {
  for (const [code, help] of Object.entries(ERROR_CODES)) {
    if (help.remedy === undefined) continue;
    const forms = help.remedy.includes(COMMAND_SLOT) ? browseCommands().map((name) => help.remedy?.replaceAll(COMMAND_SLOT, name) as string) : [help.remedy];
    for (const form of forms) expect(checkCommand(form), `${code}: ${form}`).toEqual([]);
  }
});

test("the generated sections replace only their own part of a file", () => {
  expect(replaceSection("# A\n\ntext\n", "## Codes", "## Codes\n\nrows\n")).toBe("# A\n\ntext\n\n## Codes\n\nrows\n");
  expect(replaceSection("# A\n\ntext\n\n## Codes\n\nold\n", "## Codes", "## Codes\n\nnew\n")).toBe("# A\n\ntext\n\n## Codes\n\nnew\n");
  const out = generated(new Map([["SKILL.md", "# Ardia\n"]]));
  expect(out.get("SKILL.md")).toContain("`ardia browse` takes ");
  expect(out.get(COMMANDS_FILE)).toContain("- **perf**: `ardia browse perf trace");
});

test("the new commands are known, flagged and documented", () => {
  for (const name of ["perf", "styles", "issues", "logpoint"]) {
    expect(KNOWN_COMMANDS).toContain(name);
    expect(COMMAND_FLAGS[name]?.length).toBeGreaterThan(0);
  }
  expect(COMMAND_FLAGS["errors"]).toContain("--uncaught");
  expect(COMMAND_FLAGS["perf"]).toContain("--crux");
});

test("the skill folder on disk regenerates to itself", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "skill-gen-"));
  try {
    for (const [name, text] of SKILL_FILES) {
      const file = path.join(folder, name);
      Bun.spawnSync(["mkdir", "-p", path.dirname(file)]);
      writeFileSync(file, text);
    }
    expect(stale(folder)).toEqual([]);
    writeFileSync(path.join(folder, COMMANDS_FILE), "stale\n");
    expect(stale(folder)).toEqual([COMMANDS_FILE]);
    expect(readFileSync(path.join(folder, "SKILL.md"), "utf8")).toContain("## Commands");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
