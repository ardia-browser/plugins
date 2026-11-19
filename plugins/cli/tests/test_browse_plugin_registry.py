import asyncio
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli.browse import paths
from ardia_cli.browse.state import State
from ardia_cli.browse.tabs import Registry

SCRATCH = Path.home() / "ardia-scratch"


class ScopedBrowser:
    def __init__(self, targets):
        self.targets = targets

    async def send(self, method, params=None):
        assert method == "Target.getTargets"
        return {"targetInfos": [{"targetId": target, "type": "page", "url": "https://example.com/"} for target in self.targets]}


class PluginRegistry(unittest.TestCase):
    def setUp(self):
        SCRATCH.mkdir(exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="plugin-registry-", dir=SCRATCH))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        self.fd = paths.browse_dir(root)
        self.addCleanup(os.close, self.fd)
        for key in ("ka", "kb"):
            lock = paths.take_lock(f"{key}.lock", self.fd)
            self.addCleanup(os.close, lock)
        self.other = Registry(self.fd, "kb", "plugin-other")

    def state(self, for_plugin: bool, targets) -> State:
        state = State({"session": "plugin-ai", "key": "ka", "browse_fd": self.fd, "for_plugin": for_plugin}, None)
        state.instance = "127.0.0.1:9/devtools/browser/x"
        state.browser = ScopedBrowser(targets)
        return state

    def test_a_plugin_sessions_scoped_list_never_prunes_another_activitys_tabs(self):
        self.assertEqual(self.other.numbers("127.0.0.1:9/devtools/browser/x", ["THEIRS"]), {"THEIRS": "t1"})
        time.sleep(0.01)
        state = self.state(True, ["MINE"])
        asyncio.run(state.refresh_targets())
        self.assertEqual(state.tab_ids.get("MINE"), "t2")
        self.assertEqual(self.other.numbers("127.0.0.1:9/devtools/browser/x", ["THEIRS"]), {"THEIRS": "t1"})

    def test_a_persons_session_still_prunes_tabs_that_closed(self):
        self.assertEqual(self.other.numbers("127.0.0.1:9/devtools/browser/x", ["GONE"]), {"GONE": "t1"})
        time.sleep(0.01)
        asyncio.run(self.state(False, ["MINE"]).refresh_targets())
        self.assertEqual(self.other.numbers("127.0.0.1:9/devtools/browser/x", ["GONE"]), {"GONE": "t3"})


if __name__ == "__main__":
    unittest.main()
