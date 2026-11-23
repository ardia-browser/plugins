POLICY_REFUSAL = "isn't allowed for the ardia command"


class BrowseError(Exception):
    exit_code = 1

    def __init__(self, message: str, data: dict | None = None, code: str | None = None):
        super().__init__(message)
        self.message = message
        self.data = data
        self.code = code


class Unreachable(BrowseError):
    exit_code = 2


class ConnectionLost(BrowseError):
    exit_code = 2

    def __init__(self, message: str = "Ardia closed the connection (Stop was pressed, control was turned off, or Ardia quit)"):
        super().__init__(message, code="connection_lost")


class OutcomeUnknown(BrowseError):
    exit_code = 1

    def __init__(self, action: str, why: str):
        super().__init__(f"{why}; the outcome of {action} is unknown, so it wasn't retried", code="outcome_unknown")


class StaleRef(BrowseError):
    def __init__(self, ref: str, why: str):
        fix = "use that ref" if "is now @" in why else "Run `ardia browse snapshot -i` again and use the new refs"
        super().__init__(f"Stale ref @{ref}: {why}. {fix[0].upper() + fix[1:]}", code="stale_ref")


NOT_A_WEB_TAB = "the tab is gone, isn't a web page (an Ardia or extension page), or is in a window Ardia keeps for itself"
REFUSAL_HINTS = {
    "to that target": NOT_A_WEB_TAB,
    "on that target": NOT_A_WEB_TAB,
    "to that URL": "only http, https, data and about:blank pages can be opened",
    "on a tab the ardia command didn't open": "the viewport can be set only on a tab this command opened: `ardia browse open <url>`, then set it there",
    "with that option": "only a width, a height, a scale and mobile can be set",
    "on a tab that isn't off-screen": "Ardia sets a viewport only on a tab it has taken off-screen, which `ardia browse set viewport <w> <h>` does for a tab this session opened and never showed",
}


def refusal_reason(text: str, method: str) -> str:
    said = text.split(POLICY_REFUSAL, 1)[0]
    if method not in said:
        return ""
    return said.rsplit(method, 1)[1].strip()


DOWNLOAD_INSTEAD = ("`read --links <part of the link's address> --list` prints its full URL, and for a public text or JSON file "
                    "`read --http --raw <that URL>` fetches it; otherwise ask the user to download it")
SCREENSHOTS_INSTEAD = "take a `screenshot` at each moment that matters"
SIGN_IN_INSTEAD = "ask the user to sign in in the tab, then work there"
TIMINGS_INSTEAD = "`eval` can read the page's own `performance` timings"
OTHER_WAY = "do this step another way, or ask the user to do it"
FULL_CONTROL_ARDIA = "0.2.49"
NOT_YET_REASONS = frozenset({"with those editing commands"})
NOT_YET = {
    "upload": "ask the user to choose the file in the page, then carry on",
    "download": DOWNLOAD_INSTEAD,
    "wait --download": "ask the user to download the file",
    "set device": "`set viewport <w> <h>` sizes a tab this session opened and never showed",
    "set geo": "use the site's own location field, or ask the user to set the location",
    "set offline": "ask the user to take the computer offline if the check needs it",
    "set media": "read the page as it is, or ask the user to switch the system's light or dark appearance",
    "set headers": SIGN_IN_INSTEAD,
    "set credentials": SIGN_IN_INSTEAD,
    "set auth": SIGN_IN_INSTEAD,
    "set permission": "ask the user to allow it when the site asks",
    "set permissions": "ask the user to allow it when the site asks",
    "cookies": "`eval document.cookie` reads the cookies a page script can see; for the rest, ask the user",
    "state": "`storage local` and `storage session` read and write a site's storage",
    "network route": "`network requests` lists what the page loads; to change answers, ask the user what the check needs",
    "record": SCREENSHOTS_INSTEAD,
    "stream": SCREENSHOTS_INSTEAD,
    "highlight": "`screenshot` shows the page",
    "clipboard": "`fill` or `type` puts text in, and `get value` (a field) or `get text` reads it out",
    "trace": TIMINGS_INSTEAD,
    "profiler": TIMINGS_INSTEAD,
}


def instead_for(command: str | None) -> str:
    if not command:
        return OTHER_WAY
    return NOT_YET.get(command) or NOT_YET.get(command.split(" ")[0]) or OTHER_WAY


def known_limit(command: str | None) -> bool:
    return bool(command) and (command in NOT_YET or command.split(" ")[0] in NOT_YET)


def not_yet_message(command: str | None, method: str, refusal: str) -> str:
    what = f"`{command}`" if command else method
    if not known_limit(command):
        return (f"{what} isn't allowed on this Ardia ({refusal}). Its engine keeps the ardia command to a short list of DevTools "
                f"methods, and Ardia {FULL_CONTROL_ARDIA} or later allows them all: update Ardia, or {OTHER_WAY}")
    return (f"{what} needs Ardia {FULL_CONTROL_ARDIA} or later ({refusal}). This Ardia's engine keeps the ardia command to a short "
            f"list of DevTools methods; {FULL_CONTROL_ARDIA} lets it use them all, so update Ardia and run it again. "
            f"Until then: {instead_for(command)}")


class Gated(BrowseError):
    def __init__(self, method: str, command: str | None = None, detail: str | None = None, reason: str | None = None):
        self.method = method
        self.reason = reason or ""
        self.refusal = " ".join(part for part in (method, self.reason, POLICY_REFUSAL) if part)
        what = f"`{command}` needs {method}" if command else f"{method} is needed"
        if self.reason in NOT_YET_REASONS:
            message = not_yet_message(command, method, self.refusal)
        elif self.reason:
            hint = REFUSAL_HINTS.get(self.reason)
            message = (f"{what}, which this Ardia allows for the ardia command, but not {self.reason} ({self.refusal})" + (f": {hint}" if hint else "")
                       + f". Ardia {FULL_CONTROL_ARDIA} or later has no such limit")
        else:
            message = not_yet_message(command, method, self.refusal)
        super().__init__(message + (f" ({detail})" if detail else ""), data={"method": method, "reason": self.reason}, code="policy_refused")

    def during(self, command: str | None, detail: str | None = None) -> "Gated":
        return Gated(self.method, command, detail, self.reason)


class CdpError(BrowseError):
    def __init__(self, method: str, message: str, cdp_code: int | None = None):
        super().__init__(f"{method}: {message}")
        self.method = method
        self.cdp_message = message
        self.cdp_code = cdp_code


class NotFocusable(CdpError):
    def __init__(self, label: str):
        BrowseError.__init__(self, f"{label} can't take focus (it's hidden, inert or a wrapper with no field inside). Click it to open "
                                   "its field, then snapshot -i and use the field that appears", code="not_focusable")
        self.method = "DOM.focus"
        self.cdp_message = "Element is not focusable"


class CdpTimeout(BrowseError):
    def __init__(self, method: str, seconds: float):
        super().__init__(f"{method} got no answer in {seconds:g}s")
        self.method = method


class PageBusy(CdpTimeout):
    def __init__(self, method: str, seconds: float, why: str):
        BrowseError.__init__(self, f"{method} got no answer in {seconds:g}s: {why}", code="page_busy")
        self.method = method


class Usage(BrowseError):
    pass
