import asyncio

from ardia_cli.browse.errors import BrowseError, CdpError, CdpTimeout, Gated

BROWSER = "browser"
SESSION_GONE = ("Session with given id not found", "No session with given id", "no attached session has that sessionId")
SESSION_NOT_FOUND_CODE = -32001
ATTACH_TIMEOUT = 10
LATE_ATTACH_GRACE = 30
RESET_NOTICE = ("→ This session's DevTools connection was reopened since the last cdp call (it closes after 30 s idle), "
                "so cdp got a fresh session there: domains and settings earlier cdp calls turned on are off again")


class RawSessions:
    def __init__(self):
        self.browser = None
        self.sessions: dict[str, str | None] = {}
        self.reset: set[str] = set()


def of(state) -> RawSessions:
    return state.extras.setdefault("raw_cdp", RawSessions())


def forget_session(state, session_id: str | None) -> None:
    raw = state.extras.get("raw_cdp")
    if raw is None or not session_id:
        return
    for key, held in list(raw.sessions.items()):
        if held == session_id:
            del raw.sessions[key]
            raw.reset.add(key)


def forget_target(state, target_id: str | None) -> None:
    raw = state.extras.get("raw_cdp")
    if raw is not None and target_id:
        raw.sessions.pop(target_id, None)
        raw.reset.discard(target_id)


def session_gone(error: CdpError) -> bool:
    return error.cdp_code == SESSION_NOT_FOUND_CODE or any(gone in error.cdp_message for gone in SESSION_GONE)


def detach_unclaimed(browser, attaching: asyncio.Future) -> None:
    if attaching.cancelled() or attaching.exception() is not None:
        return
    session = (attaching.result() or {}).get("sessionId")
    if session:
        detaching = asyncio.ensure_future(browser.send("Target.detachFromTarget", {"sessionId": session}, timeout=ATTACH_TIMEOUT))
        detaching.add_done_callback(lambda done: done.cancelled() or done.exception())


async def attach_reply(state, method: str, params: dict | None = None) -> dict:
    browser = state.browser
    attaching = asyncio.ensure_future(browser.send(method, params, timeout=ATTACH_TIMEOUT + LATE_ATTACH_GRACE))
    try:
        return await asyncio.wait_for(asyncio.shield(attaching), ATTACH_TIMEOUT)
    except (asyncio.CancelledError, asyncio.TimeoutError) as error:
        attaching.add_done_callback(lambda done: detach_unclaimed(browser, done))
        if isinstance(error, asyncio.TimeoutError):
            raise CdpTimeout(method, ATTACH_TIMEOUT) from None
        raise


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
            raw.reset |= set(raw.sessions)
        raw.browser = state.browser
        raw.sessions = {}
    if key in raw.sessions:
        session = raw.sessions[key]
        return session, "kept" if session or key != BROWSER else "shared"
    session = await attach(state, key)
    raw.sessions[key] = session
    if session is None:
        return None, "shared"
    status = "reattached" if key in raw.reset else "attached"
    raw.reset.discard(key)
    return session, status


async def send(state, key: str, method: str, params: dict, timeout: float) -> tuple[dict, str]:
    session, status = await session_for(state, key)
    try:
        return await state.browser.send(method, params, session, timeout=timeout, mutation=True), status
    except CdpError as error:
        if session is None or not session_gone(error):
            raise
    forget_session(state, session)
    session, status = await session_for(state, key)
    return await state.browser.send(method, params, session, timeout=timeout, mutation=True), status
