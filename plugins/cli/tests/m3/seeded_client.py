import json
import os
import subprocess
import sys
from pathlib import Path

CLI = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(CLI))

BOOT = """
import base64, io, json, random, secrets, sys
sys.path.insert(0, {parent!r})
text = sys.stdin.read()
config = json.loads(text or "{{}}")
seed = config.get("harness_seed")
if seed is not None:
    random.seed(seed)
    tokens = random.Random(seed + 1)
    secrets.token_bytes = lambda n=32: tokens.randbytes(n)
    secrets.token_hex = lambda n=32: tokens.randbytes(n).hex()
    secrets.token_urlsafe = lambda n=32: base64.urlsafe_b64encode(tokens.randbytes(n)).rstrip(b"=").decode("ascii")
sys.stdin = io.StringIO(text)
from ardia_cli.browse import daemon
daemon.main()
"""


def seeded_spawn(dir_fd: int, key: str, config: dict) -> subprocess.Popen:
    from ardia_cli.browse import paths

    seed = int(os.environ.get("ARDIA_M3_SEED", "0"))
    seeded = {**config, "harness_seed": seed}
    home = os.environ.get("HOME")
    if home and os.path.isdir(home):
        with open(os.path.join(home, "spawn-config.jsonl"), "a", encoding="utf-8") as handle:
            handle.write(json.dumps(seeded, ensure_ascii=False) + "\n")
    if os.environ.get("ARDIA_BROWSE_DAEMON") == "ts":
        argv = [os.environ["ARDIA_M3_TS_PROGRAM"], "daemon"]
    else:
        argv = [sys.executable, "-I", "-c", BOOT.format(parent=str(CLI))]
    log_fd = paths.open_private_file(f"{key}.log", dir_fd, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=log_fd, stderr=log_fd, start_new_session=True, close_fds=True, cwd="/")
    finally:
        os.close(log_fd)
    process.stdin.write(json.dumps(seeded).encode())
    process.stdin.close()
    return process


def install():
    from ardia_cli.browse import client

    original = client.request
    answers = os.environ.get("ARDIA_M3_ANSWERS")

    def request(sock, payload):
        answer = original(sock, payload)
        if answers:
            with open(answers, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"request": {key: payload.get(key) for key in ("argv", "options", "stdin", "beside_if_busy", "patient_queue")},
                                         "answer": answer, "wire": payload}, ensure_ascii=False) + "\n")
        return answer

    client.spawn = seeded_spawn
    client.request = request


if __name__ == "__main__":
    install()
    sys.argv = ["ardia", *sys.argv[1:]]
    from ardia_cli.cli import main

    sys.exit(main())
