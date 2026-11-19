import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ardia_cli.browse.connection import failure
from ardia_cli.browse.daemon import render
from ardia_cli.browse.errors import CdpError


def refused(detail: str):
    return failure("Input.insertText", SimpleNamespace(detail=detail, code=-32000))


class EngineCodes(unittest.TestCase):
    def test_an_engine_refusal_carries_its_code(self):
        for code in ("tab_out_of_scope", "document_changed"):
            error = refused(f"ardia: {code}: the tab moved to another window")
            self.assertIsInstance(error, CdpError)
            self.assertEqual(error.code, code)
            self.assertEqual(error.message, f"Input.insertText: ardia: {code}: the tab moved to another window")

    def test_the_code_reaches_the_json_answer_and_its_fields(self):
        status, out, _ = render({"json": True}, error=refused("ardia: tab_out_of_scope"), name="fill")
        self.assertEqual(status, 1)
        self.assertIn('"code":"tab_out_of_scope"', out)

    def test_only_the_start_of_the_engine_message_counts(self):
        for detail in ("Element says ardia: tab_out_of_scope", "ardia: tab_out_of_scopes", "ardia: unknown_thing", "ardia: tab_out_of_scopeX"):
            self.assertIsNone(refused(detail).code, detail)


if __name__ == "__main__":
    unittest.main()
