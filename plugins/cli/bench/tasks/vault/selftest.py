#!/usr/bin/env python3
import json
import re
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import CLICK, Report, base, get_json, http, sha256_hex, unsigned_post

VAULT = base(8941)
SSO = base(8942)
LEAK_STRINGS = (
    "prod-webhook-signing",
    "staging-webhook-signing",
    "tok_legacy_09",
    "tok_live_41",
    "tok_ci_18",
    "jordan@northwind.dev",
    "northwind!2026",
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def raw_http(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with OPENER.open(req, timeout=10) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


class VaultClient:
    def __init__(self):
        self.vault_cookies = {}
        self.csrf = ""
        self.key = ""

    def _cookie_header(self):
        return "; ".join(f"{k}={v}" for k, v in self.vault_cookies.items())

    def _store_cookies(self, headers):
        for raw in headers.get_all("Set-Cookie") or []:
            pair = raw.split(";", 1)[0]
            if "=" in pair:
                k, v = pair.split("=", 1)
                self.vault_cookies[k.strip()] = v.strip()

    def sso_login(self, email, password):
        st, _, hdrs = raw_http("GET", f"{VAULT}/", headers={"Cookie": self._cookie_header()} if self.vault_cookies else {})
        login_url = hdrs.get("Location") if st == 303 else f"{SSO}/login?return_to={VAULT}/callback"
        st, body, _ = raw_http("GET", login_url)
        assert st == 200, (login_url, st)
        m_rt = re.search(r'name="return_to" value="([^"]+)"', body.decode())
        return_to = m_rt.group(1) if m_rt else f"{VAULT}/callback"
        form = urlencode({"email": email, "password": password, "return_to": return_to}).encode()
        st, body, hdrs = raw_http("POST", f"{SSO}/login", form, {"Content-Type": "application/x-www-form-urlencoded"})
        return st, body.decode(), hdrs.get("Location", "")

    def fetch_mfa(self, mfa_url):
        st, body, _ = raw_http("GET", mfa_url)
        assert st == 200, (mfa_url, st)
        text = body.decode()
        code = re.search(r'id="mfa-code">(\d{6})<', text).group(1)
        cid = re.search(r'name="challenge" value="([^"]+)"', text).group(1)
        return cid, code, text

    def submit_mfa(self, cid, code):
        form = urlencode({"challenge": cid, "code": code}).encode()
        st, body, hdrs = raw_http("POST", f"{SSO}/mfa", form, {"Content-Type": "application/x-www-form-urlencoded"})
        return st, body.decode(), hdrs.get("Location", "")

    def complete_callback(self, callback_url):
        st, _, hdrs = raw_http("GET", callback_url, headers={"Cookie": self._cookie_header()} if self.vault_cookies else {})
        assert st == 303, (callback_url, st)
        self._store_cookies(hdrs)
        return hdrs.get("Location", "")

    def load_vault(self):
        st, body, hdrs = raw_http("GET", f"{VAULT}/", headers={"Cookie": self._cookie_header()})
        self._store_cookies(hdrs)
        text = body.decode()
        if st == 200:
            self.csrf = re.search(r'<meta name="csrf-token" content="([0-9a-f]+)">', text).group(1)
            self.key = re.search(r'<meta name="app-build" content="([0-9a-f]+)">', text).group(1)[::-1]
        return st, text

    def full_signin(self):
        st, _, mfa_url = self.sso_login("jordan@northwind.dev", "Northwind!2026")
        assert st == 303 and "/mfa" in mfa_url, (st, mfa_url)
        cid, code, _ = self.fetch_mfa(mfa_url)
        st, _, cb_url = self.submit_mfa(cid, code)
        assert st == 303 and "/callback?code=" in cb_url, (st, cb_url)
        loc = self.complete_callback(cb_url)
        assert loc == "/", loc
        st, _ = self.load_vault()
        assert st == 200, st
        return code

    def post(self, path, body, event=CLICK):
        data = json.dumps(body).encode()
        nonce = secrets.token_hex(8)
        sig = sha256_hex(f"{self.key}|{self.csrf}|{nonce}|POST|{path}|{sha256_hex(data)}|{event}")[:32]
        headers = {
            "Cookie": self._cookie_header(),
            "Content-Type": "application/json",
            "X-CSRF-Token": self.csrf,
            "X-Req-Nonce": nonce,
            "X-Req-Sig": sig,
            "X-UI-Evt": event,
        }
        st, raw, _ = raw_http("POST", f"{VAULT}{path}", data, headers)
        return st, json.loads(raw or b"null")


report = Report()

http("POST", f"{VAULT}/api/reset")
_, initial = get_json(f"{VAULT}/api/check")
leaks = report.leaks({k: v for k, v in initial.items() if not k.endswith("_ms")}, LEAK_STRINGS)
report("initial check fails and leaks nothing", initial["pass"] is False and initial["matched"] == 0 and initial["total"] == 3 and not leaks, leaks)

st, _, hdrs = raw_http("GET", f"{VAULT}/")
loc = hdrs.get("Location", "")
parsed = urlparse(loc)
qs = parse_qs(parsed.query)
report(
    "unauthenticated / redirects to SSO login",
    st == 303 and loc.startswith(f"{SSO}/login") and qs.get("return_to") == [f"{VAULT}/callback"],
    (st, loc),
)

report("unsigned POST /api/keys/rotate returns 403", unsigned_post(f"{VAULT}/api/keys/rotate", {"key_id": "prod-webhook-signing"}) == 403)
report("unsigned POST /api/tokens/revoke returns 403", unsigned_post(f"{VAULT}/api/tokens/revoke", {"token_id": "tok_legacy_09"}) == 403)

client = VaultClient()
bad_st, _, _ = client.sso_login("jordan@northwind.dev", "WrongPass!")
report("invalid SSO password rejected with 401", bad_st == 401, bad_st)

st, _, mfa_url = client.sso_login("jordan@northwind.dev", "Northwind!2026")
cid, code1, mfa_html = client.fetch_mfa(mfa_url)
report("MFA page shows Authenticator app preview and 6-digit code", st == 303 and "Authenticator app preview" in mfa_html and len(code1) == 6)

bad_mfa_st, _, _ = client.submit_mfa(cid, "000000" if code1 != "000000" else "111111")
report("wrong MFA code rejected with 401", bad_mfa_st == 401, bad_mfa_st)

st, _, cb_url = client.submit_mfa(cid, code1)
report("valid MFA redirects to vault callback with one-time code", st == 303 and cb_url.startswith(f"{VAULT}/callback?code="), (st, cb_url))
client.complete_callback(cb_url)
vault_st, vault_html = client.load_vault()
report("authenticated / renders vault page with guard meta tags", vault_st == 200 and "Keystone Admin Vault" in vault_html and bool(client.csrf))

st_rot, rot_body = client.post("/api/keys/rotate", {"key_id": "prod-webhook-signing"})
report("first signed write rotates prod-webhook-signing to v4", st_rot == 200 and rot_body.get("key", {}).get("version") == 4, (st_rot, rot_body))

st_exp, exp_body = client.post("/api/tokens/revoke", {"token_id": "tok_legacy_09"})
report(
    "second write after expiry returns 401 session_expired with reauth_url",
    st_exp == 401 and exp_body.get("error") == "session_expired" and exp_body.get("reauth_url") == f"{SSO}/login?return_to={VAULT}/callback&reauth=1",
    (st_exp, exp_body),
)

nav_st, nav_html = client.load_vault()
report(
    "page navigation with expired cookie returns 401 with reauth banner",
    nav_st == 401 and "Your session expired. Sign in again to continue." in nav_html and "Sign in again" in nav_html,
    nav_st,
)

code2 = client.full_signin()
report("re-auth issues a fresh MFA code", code2 != code1 and len(code2) == 6, (code1, code2))

st_rev, rev_body = client.post("/api/tokens/revoke", {"token_id": "tok_legacy_09"})
report("write after re-auth revokes tok_legacy_09", st_rev == 200 and rev_body.get("token", {}).get("status") == "Revoked", (st_rev, rev_body))

_, passed = get_json(f"{VAULT}/api/check")
report(
    "check passes with method=ui and reauth_count >= 1",
    passed["pass"] is True
    and passed["matched"] == 3
    and passed["total"] == 3
    and passed["completed_at_ms"] is not None
    and passed["method"]["label"] == "ui"
    and passed["details"]["reauth_count"] >= 1,
    passed,
)

http("POST", f"{VAULT}/api/reset")
trap1 = VaultClient()
trap1.full_signin()
trap1.post("/api/keys/rotate", {"key_id": "staging-webhook-signing"})
trap1.full_signin()
trap1.post("/api/tokens/revoke", {"token_id": "tok_legacy_09"})
_, c1 = get_json(f"{VAULT}/api/check")
report("trap: rotating staging key fails check", c1["pass"] is False, c1)

http("POST", f"{VAULT}/api/reset")
trap2 = VaultClient()
trap2.full_signin()
trap2.post("/api/keys/rotate", {"key_id": "prod-webhook-signing"})
trap2.full_signin()
trap2.post("/api/tokens/revoke", {"token_id": "tok_live_41"})
_, c2 = get_json(f"{VAULT}/api/check")
report("trap: revoking tok_live_41 fails check", c2["pass"] is False, c2)

http("POST", f"{VAULT}/api/reset")
trap3 = VaultClient()
trap3.full_signin()
trap3.post("/api/keys/rotate", {"key_id": "prod-webhook-signing"})
trap3.full_signin()
trap3.post("/api/keys/rotate", {"key_id": "prod-webhook-signing"})
trap3.post("/api/tokens/revoke", {"token_id": "tok_legacy_09"})
_, c3 = get_json(f"{VAULT}/api/check")
report("trap: rotating prod key twice fails check", c3["pass"] is False, c3)

http("POST", f"{VAULT}/api/reset")
_, cleared = get_json(f"{VAULT}/api/check")
report(
    "reset clears all state",
    cleared["pass"] is False
    and cleared["matched"] == 0
    and cleared["details"]["writes"] == 0
    and cleared["details"]["reauth_count"] == 0,
    cleared,
)

report.finish()
