import file0 from "../assets/skill/SKILL.md" with { type: "text" };
import file1 from "../assets/skill/references/automation.md" with { type: "text" };
import fileCommands from "../assets/skill/references/commands.md" with { type: "text" };
import file2 from "../assets/skill/references/config.md" with { type: "text" };
import file3 from "../assets/skill/references/daily-reports.md" with { type: "text" };
import file4 from "../assets/skill/references/flows.md" with { type: "text" };
import file5 from "../assets/skill/references/script.md" with { type: "text" };
import file6 from "../assets/skill/references/troubleshooting.md" with { type: "text" };
import file7 from "../assets/skill/references/userscripts.md" with { type: "text" };
import hashes from "../assets/skill-hashes.json" with { type: "text" };

export const SKILL_FILES: readonly [string, string][] = [
  ["SKILL.md", file0],
  ["references/automation.md", file1],
  ["references/commands.md", fileCommands],
  ["references/config.md", file2],
  ["references/daily-reports.md", file3],
  ["references/flows.md", file4],
  ["references/script.md", file5],
  ["references/troubleshooting.md", file6],
  ["references/userscripts.md", file7],
];

export const SKILL_HASHES: string = hashes;
