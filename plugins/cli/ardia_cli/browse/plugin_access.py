import errno
import hashlib
import json
import os
import re
import select
import stat
import time

PLUGIN_MODE = "ARDIA_BROWSE_FOR_PLUGIN"
CREDENTIAL_FD = "ARDIA_PLUGIN_CREDENTIAL_FD"
ENDPOINT = "ARDIA_PLUGIN_ENDPOINT"
REFUSED = 77
CODE = "plugin_refused"
CREDENTIAL = re.compile(r"p\.[A-Za-z0-9_-]{43}")
TOKEN_SERVER = re.compile(r"ws://127\.0\.0\.1:[0-9]{1,5}/devtools/browser/[A-Za-z0-9._-]{1,128}")
FD_NUMBER = re.compile(r"[0-9]{1,5}")
MAX_READ = 256
READ_DEADLINE_S = 2.0
FIRST_FREE_FD = 3
MAX_FD = 65535
ENDPOINT_FLAGS = ("ws", "port", "cdp")
ENDPOINT_ENV = ("ARDIA_WS", "ARDIA_PORT", "ARDIA_CDP_URL", "AGENT_BROWSER_CDP")
SESSION_FLAGS = frozenset({
    "--session", "--namespace", "--data-dir", "--port", "--ws", "--cdp", "--screenshot-dir", "--screenshot-format",
    "--screenshot-quality", "--idle-timeout", "--init-script", "--enable", "--headers", "--color-scheme", "--download-path",
    "--annotate", "--no-auto-dialog", "--pin-tab", "--no-pin-tab", "--debug", "--capture-console", "--show",
    "--content-boundaries", "--out", "--stdin",
})
LOCAL_COMMANDS = ("auth", "notes", "flow", "plugin", "read", "session", "script", "cdp")


class Refused(Exception):
    pass


class Access:
    def __init__(self, credential: str, endpoint: str):
        self.credential = credential
        self.endpoint = endpoint

    @property
    def ws(self) -> str:
        return f"{self.endpoint}?token={self.credential}"

    @property
    def endpoint_key(self) -> str:
        return "plugin:" + hashlib.sha256(self.credential.encode()).hexdigest()[:32]

    @property
    def label(self) -> str:
        return self.endpoint[len("ws://"):]


def wanted(env) -> bool:
    return bool(env.get(PLUGIN_MODE))


def message(why: str) -> str:
    return f"ardia browse for a plugin ({PLUGIN_MODE}=1) {why}; nothing was sent"


def drop_credential(env) -> None:
    named = env.get(CREDENTIAL_FD) or ""
    if FD_NUMBER.fullmatch(named) and int(named) >= FIRST_FREE_FD:
        try:
            os.close(int(named))
        except OSError:
            pass


def read_all(fd: int) -> bytes:
    data = b""
    deadline = time.monotonic() + READ_DEADLINE_S
    while True:
        left = deadline - time.monotonic()
        ready, _, _ = select.select([fd], [], [], max(0.0, left))
        if not ready:
            raise Refused(f"got no credential on fd {fd} within {READ_DEADLINE_S:g} s (Ardia closes its end after writing it)")
        try:
            chunk = os.read(fd, MAX_READ + 1 - len(data))
        except InterruptedError:
            continue
        except OSError as error:
            raise Refused(f"couldn't read the credential on fd {fd} ({errno.errorcode.get(error.errno, 'error')})") from None
        if not chunk:
            return data
        data += chunk
        if len(data) > MAX_READ:
            raise Refused(f"got more than {MAX_READ} bytes on fd {fd}, which no credential is")


def take_credential(env) -> str:
    named = env.get(CREDENTIAL_FD)
    if not named:
        raise Refused(f"needs {CREDENTIAL_FD}, the descriptor Ardia passes the activity's credential on, and it isn't set")
    if not FD_NUMBER.fullmatch(named) or not FIRST_FREE_FD <= int(named) <= MAX_FD:
        raise Refused(f"needs {CREDENTIAL_FD} to name an inherited descriptor (3 or above), not {json.dumps(named, ensure_ascii=False)}")
    fd = int(named)
    try:
        try:
            info = os.fstat(fd)
        except OSError:
            raise Refused(f"was given fd {fd} for its credential, and that descriptor isn't open") from None
        if os.isatty(fd):
            raise Refused(f"was given fd {fd} for its credential, and it's a terminal")
        if not (stat.S_ISFIFO(info.st_mode) or stat.S_ISSOCK(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise Refused(f"was given fd {fd} for its credential, and it isn't a pipe, socket or file")
        text = read_all(fd).decode("latin-1")
        if not CREDENTIAL.fullmatch(text):
            raise Refused(f"got {len(text)} bytes on fd {fd} that aren't a credential (exactly p. and 43 base64url characters, no newline)")
        return text
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def token_server(env) -> str:
    endpoint = env.get(ENDPOINT)
    if endpoint is None:
        raise Refused(f"needs {ENDPOINT}, the token server Ardia gives with the credential, and it isn't set")
    if endpoint == "":
        raise Refused(f"was given an empty {ENDPOINT}: Ardia's token server is off, so turn on browser control and start the activity again")
    if not TOKEN_SERVER.fullmatch(endpoint):
        raise Refused(f"needs {ENDPOINT} to be ws://127.0.0.1:<port>/devtools/browser/<id>, not {json.dumps(endpoint, ensure_ascii=False)}")
    return endpoint


def take(env) -> Access:
    if env.get(PLUGIN_MODE) != "1":
        drop_credential(env)
        raise Refused(f"takes {PLUGIN_MODE}=1 only, not {json.dumps(env.get(PLUGIN_MODE), ensure_ascii=False)}")
    credential = take_credential(env)
    return Access(credential, token_server(env))


def after_command(argv: list[str], value_flags) -> list[str]:
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--":
            return []
        if token.startswith("-"):
            index += 2 if token in value_flags else 1
            continue
        tail = argv[index + 1:]
        return tail[:tail.index("--")] if "--" in tail else tail
    return []


def check_request(argv: list[str], found: dict, rest: list[str], env, value_flags) -> None:
    command = rest[0] if rest else ""
    if command in LOCAL_COMMANDS or (command == "close" and "--all" in rest[1:]):
        raise Refused(f"can't run `{command}` for a plugin, only page steps")
    for token in after_command(argv, value_flags):
        name = token.split("=", 1)[0]
        if name in SESSION_FLAGS:
            raise Refused(f"doesn't take {name} after the command")
    flag = next((key for key in ENDPOINT_FLAGS if key in found), None)
    if flag is not None:
        raise Refused(f"reaches the browser only through the activity's credential, so it doesn't take --{flag}")
    variable = next((name for name in ENDPOINT_ENV if env.get(name)), None)
    if variable is not None:
        raise Refused(f"reaches the browser only through the activity's credential, so {variable} must be unset")
