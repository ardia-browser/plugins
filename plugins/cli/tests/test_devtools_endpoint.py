import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CLI))

from ardia_cli import endpoint
from ardia_cli.endpoint import EndpointError, SocketRefused

FILE_TOKEN = "f" * 32
SOCKET_TOKEN = "s" * 43


def write_control(root: Path, **fields) -> Path:
    path = endpoint.control_file_path(root)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump({"port": 9222, "browser": "/devtools/browser/abc-123", "pid": os.getpid(), "generation": 3, **fields}, out)
    return path


def refusing(code: str, message: str):
    def ask(_path):
        raise SocketRefused(code, message)
    return ask


class DevtoolsEndpoint(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dte-"))

    def tearDown(self):
        import shutil

        shutil.rmtree(self.root, ignore_errors=True)

    def test_the_token_comes_from_the_socket_and_the_file_needs_none(self):
        path = write_control(self.root)
        asked = []
        found = endpoint.from_control(path, lambda sock: asked.append(sock) or {"port": 9222, "token": SOCKET_TOKEN, "generation": 3})
        self.assertEqual(found.ws, f"ws://127.0.0.1:9222/devtools/browser/abc-123?token={SOCKET_TOKEN}")
        self.assertIsNone(endpoint.read_control_file(path).token)
        self.assertEqual(len(asked), 1)

    def test_an_ardia_without_the_method_falls_back_to_the_file(self):
        path = write_control(self.root, token=FILE_TOKEN)
        self.assertTrue(endpoint.from_control(path, refusing("unknown_method", "x")).ws.endswith(f"token={FILE_TOKEN}"))
        self.assertTrue(endpoint.from_control(path, refusing("not_connected", "x")).ws.endswith(f"token={FILE_TOKEN}"))

    def test_a_refused_program_never_falls_back(self):
        path = write_control(self.root, token=FILE_TOKEN)
        with self.assertRaisesRegex(EndpointError, "didn't let this program control it"):
            endpoint.from_control(path, refusing("refused", "Not allowed"))
        with self.assertRaisesRegex(EndpointError, "Control is off"):
            endpoint.from_control(path, refusing("failed", "Control is off."))
        for code in ("unreachable", "timeout", "bad_reply"):
            with self.assertRaises(EndpointError, msg=code):
                endpoint.from_control(path, refusing(code, "after connecting"))

    def test_a_missing_socket_is_not_connected_and_one_closed_after_connecting_is_not(self):
        with self.assertRaises(SocketRefused) as missing:
            endpoint.ask_socket(self.root / "ArdiaControl.sock", timeout=5)
        self.assertEqual(missing.exception.code, "not_connected")
        silent = self.serve(lambda request: [])
        with self.assertRaises(SocketRefused) as waited:
            endpoint.ask_socket(silent, timeout=1)
        self.assertEqual(waited.exception.code, "timeout")

    def test_no_method_and_no_token_says_so(self):
        path = write_control(self.root)
        with self.assertRaisesRegex(EndpointError, "has no valid token"):
            endpoint.from_control(path, refusing("unknown_method", "x"))

    def test_another_generation_or_a_bad_answer_is_refused(self):
        path = write_control(self.root)
        with self.assertRaisesRegex(EndpointError, "restarted its DevTools connection"):
            endpoint.from_control(path, lambda _s: {"port": 9222, "token": SOCKET_TOKEN, "generation": 4})
        with self.assertRaisesRegex(EndpointError, "without a valid port, token and generation"):
            endpoint.from_control(path, lambda _s: {"port": 9222, "token": "short", "generation": 3})

    def serve(self, answer):
        path = self.root / "ArdiaControl.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        server.listen(1)

        def run():
            connection, _ = server.accept()
            buffer = b""
            with connection:
                while True:
                    chunk = connection.recv(65536)
                    if not chunk:
                        return
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        for reply in answer(json.loads(line)):
                            connection.sendall(json.dumps(reply).encode() + b"\n")

        threading.Thread(target=run, daemon=True).start()
        self.addCleanup(server.close)
        return path

    def test_the_doorbell_refusal_is_refused_not_a_closed_socket(self):
        path = self.serve(lambda request: [{"id": None, "error": {"code": "refused", "message": "Ardia turned this program away"}}] if request["method"] == "hello" else [])
        with self.assertRaises(SocketRefused) as caught:
            endpoint.ask_socket(path, timeout=5)
        self.assertEqual(caught.exception.code, "refused")

    def test_a_real_socket_answer(self):
        def answer(request):
            if request["method"] == "hello":
                return [{"id": 2, "result": {"port": 1, "token": "x" * 32, "generation": 9}}, {"id": request["id"], "result": {"app": "Ardia", "version": "0.2.49", "protocol": 4}}]
            return [{"id": request["id"], "result": {"port": 9222, "token": SOCKET_TOKEN, "generation": 3}}]

        self.assertEqual(endpoint.ask_socket(self.serve(answer), timeout=5), {"port": 9222, "token": SOCKET_TOKEN, "generation": 3})

    def test_a_real_socket_unknown_method(self):
        def answer(request):
            if request["method"] == "hello":
                return [{"id": request["id"], "result": {"app": "Ardia", "version": "0.2.48", "protocol": 4}}]
            return [{"id": request["id"], "error": {"code": "unknown_method", "message": "unknown method"}}]

        with self.assertRaises(SocketRefused) as caught:
            endpoint.ask_socket(self.serve(answer), timeout=5)
        self.assertEqual(caught.exception.code, "unknown_method")

    def test_a_frame_that_isnt_an_object_is_bad_reply(self):
        with self.assertRaises(SocketRefused) as caught:
            endpoint.ask_socket(self.serve(lambda request: [[1, 2]]), timeout=5)
        self.assertEqual(caught.exception.code, "bad_reply")

    def test_cancelling_a_command_closes_its_pending_socket(self):
        import asyncio
        import time

        from ardia_cli.browse.state import State

        saw_eof = threading.Event()
        path = self.root / "ArdiaControl.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        server.listen(1)
        self.addCleanup(server.close)

        def hold():
            connection, _ = server.accept()
            with connection:
                while connection.recv(65536):
                    pass
                saw_eof.set()

        threading.Thread(target=hold, daemon=True).start()
        state = State({"session": "t"}, lambda: endpoint.ask_socket(path, timeout=30))

        async def cancel_soon():
            task = asyncio.ensure_future(state.resolve_off_loop())
            await asyncio.sleep(0.3)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        started = time.monotonic()
        asyncio.run(cancel_soon())
        self.assertTrue(saw_eof.wait(5))
        self.assertLess(time.monotonic() - started, 10)

    def test_a_different_port_is_another_server(self):
        path = write_control(self.root)
        with self.assertRaisesRegex(EndpointError, "restarted its DevTools connection"):
            endpoint.from_control(path, lambda _s: {"port": 9333, "token": SOCKET_TOKEN, "generation": 3})

    def test_the_idle_check_reads_only_the_file(self):
        write_control(self.root)
        self.assertEqual(endpoint.resolve_instance(data_dir=str(self.root)), f"{os.getpid()}:3:/devtools/browser/abc-123")


if __name__ == "__main__":
    unittest.main()
