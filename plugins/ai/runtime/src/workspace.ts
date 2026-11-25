// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import * as Fs from "node:fs";
import * as Path from "node:path";

export const SKILL_FILE = Path.join("skill", "browser.md");

function writeIfChanged(file: string, text: string) {
  try {
    if (Fs.readFileSync(file, "utf8") === text) return;
  } catch {}
  Fs.writeFileSync(file, text, { mode: 0o600 });
}

export function skillText(pluginDir: string): string {
  return Fs.readFileSync(Path.join(pluginDir, SKILL_FILE), "utf8");
}

export function skillBody(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

export function installWorkspace(pluginDir: string, workspaceDir: string) {
  Fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  const text = skillText(pluginDir);
  const body = skillBody(text);
  writeIfChanged(Path.join(workspaceDir, "CLAUDE.md"), body);
  writeIfChanged(Path.join(workspaceDir, "AGENTS.md"), body);
  const skillDir = Path.join(workspaceDir, ".claude", "skills", "ardia-browser");
  Fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  writeIfChanged(Path.join(skillDir, "SKILL.md"), text);
}
