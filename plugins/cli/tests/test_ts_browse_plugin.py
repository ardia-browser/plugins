import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from parity import harness

CREDENTIAL = "plg_9f3KxQ2mVt7Lw8Rb1Zs4Np6Yc0Hd5Ue"
REFUSED = 77
FD = 9


def programs():
    return harness.ts_binary() is not None and harness.ts_binary().exists() and harness.binary() is not None


@unittest.skipUnless(programs(), "build plugins/cli/rust (the router) and plugins/cli/ts first")
class PluginMode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.install = harness.Installation(harness.ts_binary(), entry="ts")

    @classmethod
    def tearDownClass(cls):
        cls.install.close()

    def setUp(self):
        self.box = Path(tempfile.mkdtemp(prefix="arpl", dir="/tmp")).resolve()
        for name in ("home", "data", "cli-home"):
            (self.box / name).mkdir()
        (self.box / "data").chmod(0o700)
        (self.box / "data" / "ArdiaControl.json").write_text(json.dumps({"port": 9, "token": "decoy-token-never-read"}))
        self.daemon = None

    def stop(self):
        if self.daemon:
            self.daemon.close()
            self.daemon.path.unlink(missing_ok=True)
            self.daemon = None

    def tearDown(self):
        self.stop()
        shutil.rmtree(self.box, True)

    def serve(self, replies, credential=CREDENTIAL, session="default"):
        self.stop()
        self.daemon = harness.FakeDaemon(self.box / "data", {"endpoint": {"plugin": credential}, "session": session, "replies": replies})
        return self.daemon

    def env(self, **extra):
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.box / "home"), "ARDIA_DATA_DIR": str(self.box / "data"),
               "ARDIA_CLI_HOME": str(self.box / "cli-home"), "ARDIA_TELEMETRY": "0", "LANG": "en_US.UTF-8",
               "ARDIA_BROWSE_FOR_PLUGIN": "1", "ARDIA_PLUGIN_CREDENTIAL_FD": str(FD)}
        env.update({key: value for key, value in extra.items() if value is not None})
        for key, value in extra.items():
            if value is None:
                env.pop(key, None)
        return env

    def run_ardia(self, argv, env=None, feed=CREDENTIAL.encode() + b"\n", keep_open=False, fd_kind="pipe", watch=None):
        env = env or self.env()
        writer = None
        if fd_kind == "pipe":
            read_end, writer = os.pipe()
            if feed:
                os.write(writer, feed)
            if not keep_open:
                os.close(writer)
                writer = None
            given = read_end
        elif fd_kind == "file":
            path = self.box / "credential"
            path.write_bytes(feed)
            given = os.open(path, os.O_RDONLY)
        elif fd_kind == "write-end":
            read_end, given = os.pipe()
            os.close(read_end)
        else:
            given = None
        if given is not None:
            os.dup2(given, FD)
            os.close(given)
        process = subprocess.Popen([str(self.install.root / "bin" / "ardia"), *argv], env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(FD,) if given is not None else (),
                                   start_new_session=True)
        if given is not None:
            os.close(FD)
        seen = watch(process) if watch else None
        out, err = process.communicate(timeout=30)
        if writer is not None:
            os.close(writer)
        return process.returncode, out.decode(), err.decode(), seen

    def assertRefused(self, result, *words):
        status, out, err, _ = result
        self.assertEqual(status, REFUSED, err)
        self.assertEqual(out, "")
        self.assertEqual(err.count("\n"), 1, err)
        self.assertTrue(err.startswith("✗ ardia browse for a plugin (ARDIA_BROWSE_FOR_PLUGIN=1)"), err)
        for word in words:
            self.assertIn(word, err)
        self.assertNotIn(CREDENTIAL, err)
        if self.daemon:
            self.assertEqual(self.daemon.requests, [])
        self.assertNotIn("python", self.routes())

    def routes(self) -> list:
        seen = []
        for path in list(self.install.routes.iterdir()):
            seen += path.read_text().split()
            path.unlink()
        return seen

    def test_a_credential_ending_at_eof_reaches_the_daemon_and_nowhere_else(self):
        daemon = self.serve([{"out": "Example\n", "err": "", "exit": 0}])
        status, out, err, _ = self.run_ardia(["browse", "get", "title"], feed=CREDENTIAL.encode())
        self.assertEqual((status, out, err), (0, "Example\n", ""))
        [request] = daemon.requests
        self.assertEqual(request["plugin_credential"], CREDENTIAL)
        self.assertEqual(request["argv"], ["get", "title"])
        self.assertNotIn(CREDENTIAL, json.dumps({key: value for key, value in request.items() if key != "plugin_credential"}))

    def test_a_credential_on_one_line_works_while_ardia_keeps_its_end_open(self):
        self.serve([{"out": "ok\n", "exit": 0}])
        status, out, _, _ = self.run_ardia(["browse", "get", "url"], keep_open=True)
        self.assertEqual((status, out), (0, "ok\n"))

    def test_every_bad_descriptor_is_refused_before_anything_is_sent(self):
        cases = [
            ({"ARDIA_PLUGIN_CREDENTIAL_FD": None}, {}, "isn't set"),
            ({"ARDIA_PLUGIN_CREDENTIAL_FD": ""}, {}, "isn't set"),
            ({"ARDIA_PLUGIN_CREDENTIAL_FD": "nine"}, {}, "not \"nine\""),
            ({"ARDIA_PLUGIN_CREDENTIAL_FD": "-9"}, {}, "not \"-9\""),
            ({"ARDIA_PLUGIN_CREDENTIAL_FD": "2"}, {}, "3 or above"),
            ({"ARDIA_PLUGIN_CREDENTIAL_FD": "57"}, {}, "isn't open"),
            ({}, {"fd_kind": "file"}, "isn't a pipe or a socket"),
            ({}, {"fd_kind": "write-end"}, "couldn't read the credential"),
            ({}, {"feed": b""}, "isn't one Ardia issues"),
            ({}, {"feed": b"short\n"}, "isn't one Ardia issues"),
            ({}, {"feed": b"has spaces in it, sixteen+\n"}, "isn't one Ardia issues"),
            ({}, {"feed": CREDENTIAL.encode() + b"\nmore\n"}, "more than one line"),
            ({}, {"feed": b"a" * 2000}, "longer than"),
            ({}, {"feed": b"", "keep_open": True}, "within 2 s"),
            ({"ARDIA_BROWSE_FOR_PLUGIN": "yes"}, {}, "takes ARDIA_BROWSE_FOR_PLUGIN=1 only"),
        ]
        for env, how, words in cases:
            with self.subTest(env=env, how=how):
                self.serve([{"out": "never\n", "exit": 0}])
                self.assertRefused(self.run_ardia(["browse", "get", "title"], env=self.env(**env), **how), words)
                self.stop()

    def test_another_endpoint_or_a_missing_daemon_is_refused_and_python_never_runs(self):
        for argv, env, words in [
            (["browse", "--port", "9222", "get", "title"], {}, "--port"),
            (["--ws", "ws://127.0.0.1:9/x", "browse", "get", "title"], {}, "--ws"),
            (["browse", "get", "title"], {"AGENT_BROWSER_CDP": "9222"}, "AGENT_BROWSER_CDP"),
            (["browse", "get", "title"], {"ARDIA_CDP_URL": "ws://127.0.0.1:9/x"}, "ARDIA_CDP_URL"),
            (["browse", "--help"], {}, "help"),
            (["browse", "auth", "list"], {}, "local commands"),
        ]:
            with self.subTest(argv=argv, env=env):
                self.serve([{"out": "never\n", "exit": 0}])
                self.assertRefused(self.run_ardia(argv, env=self.env(**env)), words)
                self.stop()
        self.assertRefused(self.run_ardia(["browse", "get", "title"]), "no running browse session")

    def test_expect_loader_is_checked_before_and_after(self):
        loaders = {"before": "L1", "after": "L1"}
        for main, status, shown in [
            (loaders, 0, "T\n"),
            ({"before": "L0", "after": "L1"}, 1, "changed document before"),
            ({"before": "L1", "after": "L2"}, 1, "changed document while"),
            (None, 1, "didn't report the page's document"),
        ]:
            with self.subTest(main=main):
                reply = {"out": "T\n", "exit": 0, **({"main_loader": main} if main else {})}
                daemon = self.serve([reply])
                code, out, err, _ = self.run_ardia(["browse", "--json", "get", "title", "--expect-loader", "L1"])
                self.assertEqual(code, status, err)
                [request] = daemon.requests
                self.assertEqual(request["expect_loader"], "L1")
                self.assertEqual(request["argv"], ["get", "title"])
                if status == 0:
                    self.assertEqual(out, shown)
                else:
                    payload = json.loads(out)
                    self.assertEqual((payload["success"], payload["code"]), (False, "document_changed"))
                    self.assertIn(shown, payload["error"])
                    self.assertNotIn("T", out.replace("The", ""))
                self.stop()

    def test_the_credential_is_in_no_argv_or_environment_and_its_descriptor_is_closed(self):
        self.serve([{"hang": 3}])

        def watch(process):
            time.sleep(1.2)
            rows = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,args="], capture_output=True, text=True).stdout.splitlines()
            family, mine = {process.pid}, []
            for _ in range(4):
                for row in rows:
                    pid, ppid, args = row.split(None, 2) + [""] * (3 - len(row.split(None, 2)))
                    if int(ppid) in family and int(pid) not in family:
                        family.add(int(pid))
            for pid in sorted(family):
                args = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True).stdout
                environ = subprocess.run(["ps", "-E", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
                files = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", str(FD)], capture_output=True, text=True).stdout
                mine.append((pid, args, environ, files))
            return mine

        _, _, _, seen = self.run_ardia(["browse", "get", "title"], watch=watch)
        self.assertGreaterEqual(len(seen), 2, seen)
        for pid, args, environ, files in seen:
            self.assertNotIn(CREDENTIAL, args, pid)
            self.assertNotIn(CREDENTIAL, environ, pid)
        ts = [row for row in seen if "ardia-ts.bin" in row[1]]
        self.assertTrue(ts, seen)
        self.assertEqual(ts[0][3].strip(), "", f"fd {FD} is still open in the TypeScript client")

    def test_python_refuses_plugin_mode_on_its_own(self):
        env = self.env()
        env["PYTHONPATH"] = str(harness.CLI)
        result = subprocess.run([str(self.install.python), "-I", "-m", "ardia_cli", "browse", "get", "title"], env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, REFUSED, result.stderr)
        self.assertIn("runs only on the TypeScript client", result.stderr)


if __name__ == "__main__":
    unittest.main()
