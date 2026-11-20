from ardia_cli.browse.errors import BrowseError, CdpError, Gated

BROWSER = "browser"
SESSION_GONE = ("Session with given id not found", "No session with given id", "no attached session has that sessionId")
SESSION_NOT_FOUND_CODE = -32001
INVALID_PARAMS_CODE = -32602
ATTACH_TIMEOUT = 10
USER_ATTACHES = ("Target.attachToTarget", "Target.attachToBrowserTarget")
RESET_NOTICES = {
    "reopened": "→ This session's DevTools connection was reopened since the last cdp call (it closes after 30 s idle), "
                "so cdp got a fresh session there: domains and settings earlier cdp calls turned on are off again",
    "replaced": "→ The DevTools session earlier cdp calls used there was gone (the tab or Ardia dropped it), so cdp attached a new one "
                "on the same DevTools connection: domains and settings earlier cdp calls turned on are off again",
}


class RawSessions:
    def __init__(self):
        self.browser = None
        self.sessions: dict[str, str | None] = {}
        self.reset: dict[str, str] = {}


def of(state) -> RawSessions:
    return state.extras.setdefault("raw_cdp", RawSessions())


def forget_session(state, session_id: str | None) -> None:
    raw = state.extras.get("raw_cdp")
    if raw is None or not session_id:
        return
    for key, held in list(raw.sessions.items()):
        if held == session_id:
            del raw.sessions[key]
            raw.reset[key] = "replaced"


def forget_target(state, target_id: str | None) -> None:
    raw = state.extras.get("raw_cdp")
    if raw is not None and target_id:
        raw.sessions.pop(target_id, None)
        raw.reset.pop(target_id, None)


def session_gone(error: CdpError) -> bool:
    if error.cdp_code == INVALID_PARAMS_CODE:
        return False
    return error.cdp_code == SESSION_NOT_FOUND_CODE or any(gone in error.cdp_message for gone in SESSION_GONE)


async def attach_reply(state, method: str, params: dict | None = None) -> dict:
    from ardia_cli.browse.connection import claimed_attach

    return await claimed_attach(state.browser, method, params, ATTACH_TIMEOUT)


async def attach(state, key: str) -> str | None:
    if key == BROWSER:
        try:
            return (await attach_reply(state, "Target.attachToBrowserTarget"))["sessionId"]
        except (Gated, CdpError, KeyError):
            return None
    try:
        return (await attach_reply(state, "Target.attachToTarget", {"targetId": key, "flatten": True}))["sessionId"]
    except Gated as error:
        raise error.during("cdp") from None
    except KeyError:
        raise BrowseError("Ardia didn't give cdp a session on that tab", code="tab_detached") from None


async def session_for(state, key: str) -> tuple[str | None, str]:
    raw = of(state)
    if raw.browser is not state.browser:
        if raw.browser is not None:
            raw.reset = {held: "reopened" for held in (*raw.reset, *raw.sessions)}
        raw.browser = state.browser
        raw.sessions = {}
    if key in raw.sessions:
        session = raw.sessions[key]
        return session, "kept" if session or key != BROWSER else "shared"
    session = await attach(state, key)
    raw.sessions[key] = session
    if session is None:
        return None, "shared"
    reason = raw.reset.pop(key, None)
    if reason is None:
        return session, "attached"
    state.extras["notice"] = "\n".join(part for part in (state.extras.get("notice"), RESET_NOTICES[reason]) if part)
    return session, "reattached"


async def call(state, method: str, params: dict, session: str | None, timeout: float) -> dict:
    from ardia_cli.browse.connection import claimed_attach

    if method in USER_ATTACHES:
        return await claimed_attach(state.browser, method, params, timeout, session, unknown=True)
    return await state.browser.send(method, params, session, timeout=timeout, mutation=True)


async def send(state, key: str, method: str, params: dict, timeout: float) -> tuple[dict, str]:
    session, status = await session_for(state, key)
    try:
        return await call(state, method, params, session, timeout), status
    except CdpError as error:
        if session is None or not session_gone(error):
            raise
    forget_session(state, session)
    session, status = await session_for(state, key)
    return await call(state, method, params, session, timeout), status
