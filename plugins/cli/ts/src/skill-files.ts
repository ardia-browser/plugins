import file0 from "../../ardia_cli/skill/SKILL.md" with { type: "text" };
import file1 from "../../ardia_cli/skill/references/automation.md" with { type: "text" };
import file2 from "../../ardia_cli/skill/references/config.md" with { type: "text" };
import file3 from "../../ardia_cli/skill/references/daily-reports.md" with { type: "text" };
import file4 from "../../ardia_cli/skill/references/flows.md" with { type: "text" };
import file5 from "../../ardia_cli/skill/references/script.md" with { type: "text" };
import file6 from "../../ardia_cli/skill/references/troubleshooting.md" with { type: "text" };
import file7 from "../../ardia_cli/skill/references/userscripts.md" with { type: "text" };
import hashes from "../../ardia_cli/skill_hashes.json" with { type: "text" };

export const SKILL_FILES: readonly [string, string][] = [
  ["SKILL.md", file0],
  ["references/automation.md", file1],
  ["references/config.md", file2],
  ["references/daily-reports.md", file3],
  ["references/flows.md", file4],
  ["references/script.md", file5],
  ["references/troubleshooting.md", file6],
  ["references/userscripts.md", file7],
];

export const SKILL_HASHES: string = hashes;
