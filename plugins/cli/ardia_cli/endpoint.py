import errno
import json
import os
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from ardia_cli.redact import add_secret, redact

CONTROL_FILE = "ArdiaControl.json"
DATA_DIR_HELP = "the Ardia data dir (default: $ARDIA_DATA_DIR, else the installed app's)"
LINUX = sys.platform.startswith("linux")
NOT_REACHABLE = (
    "Ardia isn't running, or \"Let the ardia command control Ardia\" is off in Settings."
    if LINUX
    else "Ardia isn't running, or Command Line isn't installed (Settings › Plugins)."
)


def xdg_dir(variable: str, *fallback: str, absolute: bool = False) -> Path:
    value = os.environ.get(variable)
    if value and (os.path.isabs(value) or not absolute):
        return Path(value)
    return Path.home().joinpath(*fallback)


def config_home(absolute: bool = False) -> Path:
    return xdg_dir("XDG_CONFIG_HOME", ".config", absolute=absolute)


def installed_data_dir(linux: bool | None = None) -> Path:
    if not (LINUX if linux is None else linux):
        return Path.home() / "Library" / "Application Support" / "com.ardia.browser"
    override = os.environ.get("ARDIA_CONFIG_HOME")
    return (Path(override) if override else config_home()) / "ardia"


LINUX_DATA_DIR_SHOWN = "${ARDIA_CONFIG_HOME:-${XDG_CONFIG_HOME:-~/.config}}/ardia"


def chromium_dir(root: Path, linux: bool | None = None) -> Path:
    return Path(root) if (LINUX if linux is None else linux) else Path(root) / "Chromium"


def control_file_path(root: Path) -> Path:
    return chromium_dir(root) / CONTROL_FILE


INSTALLED_DATA_DIR = installed_data_dir()
_BROWSER_PATH = re.compile(r"^/devtools/browser/[0-9A-Za-z-]{1,128}$")
_TOKEN = re.compile(r"^[\x21-\x7e]{16,1024}$")
_MAX_CONTROL_FILE = 64 * 1024


class EndpointError(Exception):
    pass


@dataclass(frozen=True)
class Endpoint:
    ws: str
    source: str
    explicit: bool
    active: str | None = None
    instance: str | None = None


def resolve(ws: str | None = None, port: int | None = None, data_dir: str | None = None) -> Endpoint:
    if ws:
        return _from_ws(ws, "--ws")
    if port is not None:
        return _from_port(port, "--port")
    env_ws = os.environ.get("ARDIA_WS")
    if env_ws:
        return _from_ws(env_ws, "ARDIA_WS")
    env_port = os.environ.get("ARDIA_PORT")
    if env_port:
        return _from_port(env_port_number(env_port), "ARDIA_PORT")
    env_cdp = os.environ.get("ARDIA_CDP_URL")
    if env_cdp:
        return _from_ws(env_cdp, "ARDIA_CDP_URL")
    return from_control(control_file_path(data_root(data_dir)))


def env_port_number(text: str) -> int:
    try:
        return int(text)
    except ValueError:
        raise EndpointError(f"ARDIA_PORT must be a port number, not {text!r}") from None


def data_root(data_dir: str | None = None) -> Path:
    root = data_dir or os.environ.get("ARDIA_DATA_DIR")
    return Path(root).expanduser() if root else INSTALLED_DATA_DIR


def explicit_data_root(data_dir: str | None = None) -> Path | None:
    root = data_dir or os.environ.get("ARDIA_DATA_DIR")
    return Path(root).expanduser() if root else None


def require_control(root: Path) -> "ControlRecord":
    return read_control_file(control_file_path(root))


def _from_ws(url: str, source: str) -> Endpoint:
    parts = urlsplit(url)
    if parts.scheme not in ("ws", "wss") or not parts.netloc or not parts.path.startswith("/devtools/browser/"):
        raise EndpointError(f"{source} must be a ws://host:port/devtools/browser/<id> URL")
    for token in parse_qs(parts.query).get("token", []):
        add_secret(token)
    return Endpoint(url, source, True, instance=f"{parts.netloc}{parts.path}")


def _from_port(port: int, source: str) -> Endpoint:
    import urllib.request

    if not 0 < port < 65536:
        raise EndpointError(f"{source} must be between 1 and 65535, not {port}")
    try:
        direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with direct.open(f"http://127.0.0.1:{port}/json/version", timeout=3) as response:
            info = json.loads(response.read(_MAX_CONTROL_FILE))
    except Exception as error:
        raise EndpointError(f"no DevTools server answers on 127.0.0.1:{port} ({_reason(error)})") from None
    ws = info.get("webSocketDebuggerUrl") if isinstance(info, dict) else None
    if not isinstance(ws, str):
        raise EndpointError(f"127.0.0.1:{port}/json/version has no webSocketDebuggerUrl")
    return _from_ws(ws, f"{source} {port}")


def _reason(error: Exception) -> str:
    reason = getattr(error, "reason", None)
    return str(reason or error) or type(error).__name__


@dataclass(frozen=True)
class ControlRecord:
    path: Path
    port: int
    browser: str
    token: str | None
    pid: int
    generation: int | None


def read_control_file(path: Path) -> ControlRecord:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise EndpointError(NOT_REACHABLE) from None
    except OSError as error:
        reason = "is a symbolic link" if error.errno == errno.ELOOP else error.strerror
        raise EndpointError(f"{NOT_REACHABLE} ({path.name} {reason})") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise EndpointError(f"{NOT_REACHABLE} ({path.name} isn't a regular file)")
        if info.st_uid != os.getuid():
            raise EndpointError(f"{NOT_REACHABLE} ({path.name} belongs to another user)")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise EndpointError(f"{NOT_REACHABLE} ({path.name} must be mode 0600)")
        raw = os.read(fd, _MAX_CONTROL_FILE + 1)
    finally:
        os.close(fd)
    try:
        control = json.loads(raw)
    except ValueError:
        raise EndpointError(f"{NOT_REACHABLE} ({path.name} isn't valid JSON)") from None
    if not isinstance(control, dict):
        raise EndpointError(f"{NOT_REACHABLE} ({path.name} isn't valid)")
    port = control.get("port")
    browser = control.get("browser")
    token = control.get("token")
    pid = control.get("pid")
    generation = control.get("generation")
    if not (isinstance(port, int) and 0 < port < 65536):
        raise EndpointError(f"{NOT_REACHABLE} ({path.name} has no valid port)")
    if not (isinstance(browser, str) and _BROWSER_PATH.match(browser)):
        raise EndpointError(f"{NOT_REACHABLE} ({path.name} has no valid browser path)")
    if token is not None and not (isinstance(token, str) and _TOKEN.match(token)):
        raise EndpointError(f"{NOT_REACHABLE} ({path.name} has no valid token)")
    if isinstance(token, str):
        add_secret(token)
    if not (isinstance(pid, int) and pid > 1 and _alive(pid)):
        raise EndpointError(NOT_REACHABLE)
    return ControlRecord(path, port, browser, token, pid, generation if isinstance(generation, int) else None)


def _endpoint_of(record: ControlRecord, port: int, token: str) -> Endpoint:
    query = f"token={quote(token, safe='')}"
    return Endpoint(
        f"ws://127.0.0.1:{port}{record.browser}?{query}",
        str(record.path),
        False,
        f"http://127.0.0.1:{port}/ardia/active?{query}",
        f"{record.pid}:{record.generation if record.generation is not None else 0}:{record.browser}",
    )


def from_control_file(path: Path) -> Endpoint:
    record = read_control_file(path)
    if record.token is None:
        raise EndpointError(f"{NOT_REACHABLE} ({path.name} has no valid token)")
    return _endpoint_of(record, record.port, record.token)


import contextvars

OPEN_SOCKETS: contextvars.ContextVar[list | None] = contextvars.ContextVar("ardia_open_sockets", default=None)
DEVTOOLS_ENDPOINT_METHOD = "control.devtoolsEndpoint"
DEVTOOLS_ENDPOINT_TIMEOUT = 70.0


class SocketRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def ask_socket(sock_path: Path, timeout: float = DEVTOOLS_ENDPOINT_TIMEOUT):
    import socket as sockets
    import time

    from ardia_cli import control

    try:
        control.check_socket(sock_path)
    except control.Unreachable as error:
        raise SocketRefused("not_connected", str(error)) from None
    deadline = time.monotonic() + timeout
    sock = sockets.socket(sockets.AF_UNIX, sockets.SOCK_STREAM)
    sock.settimeout(timeout)
    sink = OPEN_SOCKETS.get()
    if sink is not None:
        sink.append(sock)
    try:
        try:
            sock.connect(str(sock_path))
        except OSError as error:
            raise SocketRefused("not_connected", error.strerror or str(error)) from None
        if control.peer_uid(sock) != os.getuid():
            raise SocketRefused("unreachable", "the control socket is served by another user")
        sock.sendall(control.request_line(1, "hello", {"protocol": control.PROTOCOL}))
        greeted = False
        buffer = b""
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise SocketRefused("timeout", f"the control socket didn't answer {DEVTOOLS_ENDPOINT_METHOD} in time")
            sock.settimeout(left)
            try:
                chunk = sock.recv(65536)
            except TimeoutError:
                raise SocketRefused("timeout", f"the control socket didn't answer {DEVTOOLS_ENDPOINT_METHOD} in time") from None
            except OSError as error:
                raise SocketRefused("unreachable", str(error)) from None
            if not chunk:
                raise SocketRefused("unreachable", "the control socket closed")
            buffer += chunk
            if len(buffer) > control.MAX_LINE and b"\n" not in buffer:
                raise SocketRefused("too_long", "the control socket's answer is too long")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                try:
                    reply = json.loads(line)
                except ValueError:
                    raise SocketRefused("bad_reply", "the control socket's answer isn't JSON") from None
                if not isinstance(reply, dict):
                    raise SocketRefused("bad_reply", "the control socket's answer isn't an object")
                failed = reply.get("error") if isinstance(reply.get("error"), dict) else {}
                if reply.get("id") is None and "error" in reply:
                    raise SocketRefused(str(failed.get("code") or "refused"), str(failed.get("message") or "Ardia turned this program away"))
                if reply.get("id") == 1:
                    result = reply.get("result")
                    if "error" in reply or not isinstance(result, dict) or result.get("app") != "Ardia":
                        raise SocketRefused("unreachable", "something other than Ardia answers on the control socket")
                    greeted = True
                    sock.sendall(control.request_line(2, DEVTOOLS_ENDPOINT_METHOD))
                elif reply.get("id") == 2 and greeted:
                    if "error" in reply:
                        raise SocketRefused(str(failed.get("code") or "failed"), str(failed.get("message") or "failed"))
                    return reply.get("result")
    finally:
        sock.close()


def _granted(answer) -> tuple[int, str, int]:
    port = answer.get("port") if isinstance(answer, dict) else None
    token = answer.get("token") if isinstance(answer, dict) else None
    generation = answer.get("generation") if isinstance(answer, dict) else None
    if not (isinstance(port, int) and 0 < port < 65536 and isinstance(token, str) and _TOKEN.match(token) and isinstance(generation, int)):
        raise EndpointError(f"{NOT_REACHABLE} (Ardia's control socket answered {DEVTOOLS_ENDPOINT_METHOD} without a valid port, token and generation)")
    add_secret(token)
    return port, token, generation


def from_control(path: Path, ask=None) -> Endpoint:
    from ardia_cli import control

    record = read_control_file(path)
    try:
        answer = (ask or ask_socket)(control.announce_path(str(path)))
    except SocketRefused as error:
        if error.code == "unknown_method" or (error.code == "not_connected" and record.token is not None):
            if record.token is None:
                raise EndpointError(f"{NOT_REACHABLE} ({path.name} has no valid token)") from None
            return _endpoint_of(record, record.port, record.token)
        if error.code == "refused":
            raise EndpointError(f"Ardia didn't let this program control it ({redact(error.message)})") from None
        raise EndpointError(f"{NOT_REACHABLE} ({redact(error.message)})") from None
    port, token, generation = _granted(answer)
    if (record.generation, record.port) != (generation, port):
        record = read_control_file(path)
        if (record.generation, record.port) != (generation, port):
            raise EndpointError(f"{NOT_REACHABLE} (Ardia restarted its DevTools connection while this command connected; run it again)")
    return _endpoint_of(record, port, token)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    return True


def resolve_instance(ws: str | None = None, port: int | None = None, data_dir: str | None = None) -> str | None:
    if ws or port is not None or os.environ.get("ARDIA_WS") or os.environ.get("ARDIA_PORT") or os.environ.get("ARDIA_CDP_URL"):
        return resolve(ws=ws, port=port, data_dir=data_dir).instance
    record = read_control_file(control_file_path(data_root(data_dir)))
    return f"{record.pid}:{record.generation if record.generation is not None else 0}:{record.browser}"
