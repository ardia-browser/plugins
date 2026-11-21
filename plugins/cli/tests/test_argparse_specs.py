import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import argparse_specs


class ArgparseSpecs(unittest.TestCase):
    def test_the_typescript_specs_match_the_python_parsers(self):
        self.assertEqual(argparse_specs.SPECS.read_text(), argparse_specs.specs(),
                         "ts/src/argparse-specs.json is stale; regenerate it: python -m tests.argparse_specs")


if __name__ == "__main__":
    unittest.main()
