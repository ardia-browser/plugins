import sys
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
PACK = CLI / "ts" / "src" / "skill-files.ts"
REGENERATE = "python -c 'from tests.test_ts_skill_files import ts_skill_files; print(ts_skill_files(), end=\"\")' > ts/src/skill-files.ts"


def ts_skill_files() -> str:
    if str(CLI) not in sys.path:
        sys.path.insert(0, str(CLI))
    from ardia_cli import skills

    names = skills.shipped_files()
    imports = "".join(f'import file{index} from "../../ardia_cli/skill/{name}" with {{ type: "text" }};\n' for index, name in enumerate(names))
    rows = "".join(f'  ["{name}", file{index}],\n' for index, name in enumerate(names))
    return (
        imports
        + 'import hashes from "../../ardia_cli/skill_hashes.json" with { type: "text" };\n\n'
        + f"export const SKILL_FILES: readonly [string, string][] = [\n{rows}];\n\n"
        + "export const SKILL_HASHES: string = hashes;\n"
    )


class TsSkillFiles(unittest.TestCase):
    def test_the_program_embeds_every_shipped_file(self):
        self.assertEqual(PACK.read_text(), ts_skill_files(), f"ts/src/skill-files.ts is stale; regenerate it: {REGENERATE}")


if __name__ == "__main__":
    unittest.main()
