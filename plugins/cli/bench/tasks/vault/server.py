#!/usr/bin/env python3
import copy
import hashlib
import html
import json
import secrets
import sys
import threading
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, PORT_OFFSET, now_ms, serve_forever
from realism import Guard

VAULT_PORT = 8941
SSO_PORT = 8942
HERE = Path(__file__).resolve().parent
GUARD = Guard("vault")
SSO_EMAIL = "jordan@northwind.dev"
SSO_PASSWORD = "Northwind!2026"
LOGIN_URL = f"http://127.0.0.1:{SSO_PORT}/login?return_to=http://127.0.0.1:{VAULT_PORT}/callback"
REAUTH_URL = f"http://127.0.0.1:{SSO_PORT}/login?return_to=http://127.0.0.1:{VAULT_PORT}/callback&reauth=1"

INITIAL_KEYS = [
    {"id": "prod-webhook-signing", "version": 3, "status": "Active", "scope": "Production webhooks", "updated": "2026-08-14"},
    {"id": "staging-webhook-signing", "version": 2, "status": "Active", "scope": "Staging webhooks", "updated": "2026-09-02"},
]

INITIAL_TOKENS = [
    {"id": "tok_live_41", "status": "Active", "label": "Billing", "last_used": "2026-11-06"},
    {"id": "tok_legacy_09", "status": "Deprecated", "label": "Q1 Migration", "last_used": "2026-04-19"},
    {"id": "tok_ci_18", "status": "Active", "label": "Deploy", "last_used": "2026-11-06"},
]

LOCK = threading.Lock()
STATE = {}


def reset_state():
    with LOCK:
        STATE.clear()
        STATE.update(
            keys=copy.deepcopy(INITIAL_KEYS),
            tokens=copy.deepcopy(INITIAL_TOKENS),
            active_tokens={},
            expired_tokens=set(),
            mfa_challenges={},
            auth_codes={},
            login_seq=0,
            auth_sessions_issued=0,
            expiry_triggered=False,
            reauth_count=0,
            writes=0,
            passing_since=None,
            reset_at_ms=now_ms(),
        )
    GUARD.reset()


def next_mfa_code_locked():
    STATE["login_seq"] += 1
    digest = hashlib.sha256(f"northwind-sso-mfa-{STATE['login_seq']}".encode()).hexdigest()
    num = int(digest[:8], 16) % 900000 + 100000
    return f"{num:06d}"


def get_cookie(handler, name):
    jar = SimpleCookie()
    try:
        jar.load(handler.headers.get("Cookie") or "")
    except Exception:
        return None
    return jar[name].value if name in jar else None


def grade_locked():
    keys = {k["id"]: k for k in STATE["keys"]}
    tokens = {t["id"]: t for t in STATE["tokens"]}
    items = {
        "target_key_rotated": keys["prod-webhook-signing"]["version"] == 4,
        "target_token_revoked": tokens["tok_legacy_09"]["status"] == "Revoked",
        "session_reauthenticated": STATE["reauth_count"] >= 1,
    }
    invariants = {
        "other_key_untouched": keys["staging-webhook-signing"]["version"] == 2,
        "other_tokens_untouched": tokens["tok_live_41"]["status"] == "Active" and tokens["tok_ci_18"]["status"] == "Active",
    }
    passed = all(items.values()) and all(invariants.values())
    wrong = sorted([k for k, ok in items.items() if not ok] + [k for k, ok in invariants.items() if not ok])
    rotated_count = sum(1 for k, orig in zip(STATE["keys"], INITIAL_KEYS) if k["version"] != orig["version"])
    revoked_count = sum(1 for t in STATE["tokens"] if t["status"] == "Revoked")
    return {
        "pass": passed,
        "matched": sum(items.values()),
        "total": len(items),
        "completed_at_ms": STATE["passing_since"] if passed else None,
        "reset_at_ms": STATE["reset_at_ms"],
        "details": {
            "writes": STATE["writes"],
            "reauth_count": STATE["reauth_count"],
            "expiry_triggered": STATE["expiry_triggered"],
            "rotated_keys_count": rotated_count,
            "revoked_tokens_count": revoked_count,
            "invariants_ok": all(invariants.values()),
            "wrong": wrong,
        },
    }


def record_mutation_locked():
    STATE["writes"] += 1
    at = now_ms()
    g = grade_locked()
    STATE["passing_since"] = (STATE["passing_since"] or at) if g["pass"] else None


def check():
    with LOCK:
        g = grade_locked()
    g["method"] = GUARD.summary()
    return g


def maybe_expire_first_session_locked(token):
    sess = STATE["active_tokens"].get(token)
    if sess and sess.get("expires_after_first_write") and not STATE["expiry_triggered"]:
        STATE["expiry_triggered"] = True
        STATE["active_tokens"].pop(token, None)
        STATE["expired_tokens"].add(token)


def validate_return_to(raw):
    expected_port = VAULT_PORT + PORT_OFFSET
    if raw:
        parsed = urlparse(raw)
        if parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost") and parsed.port in (VAULT_PORT, expected_port) and parsed.path == "/callback":
            return f"http://127.0.0.1:{VAULT_PORT}/callback"
    return f"http://127.0.0.1:{VAULT_PORT}/callback"


def render_sso_login(return_to, error="", email="", reauth=False):
    notice = '<div class="banner warning" role="alert">Your Keystone Admin Vault session expired. Sign in again to continue.</div>' if reauth else ""
    err_html = f'<div class="banner error" role="alert">{html.escape(error)}</div>' if error else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Northwind SSO</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card">
      <div class="brand">
        <span class="brand-mark">NW</span>
        <div>
          <h1>Northwind SSO</h1>
          <p class="subtitle">Sign in to continue to Keystone Admin Vault</p>
        </div>
      </div>
      {notice}
      {err_html}
      <form method="POST" action="/login" class="auth-form">
        <input type="hidden" name="return_to" value="{html.escape(return_to)}">
        <label class="field">
          <span>Work email</span>
          <input type="email" name="email" value="{html.escape(email)}" autocomplete="username" placeholder="name@northwind.dev" required>
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <button type="submit" class="btn-primary">Continue</button>
      </form>
    </section>
  </main>
</body>
</html>"""


def render_sso_mfa(challenge_id, mfa_code, email, error=""):
    err_html = f'<div class="banner error" role="alert">{html.escape(error)}</div>' if error else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Two-factor verification — Northwind SSO</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card">
      <div class="brand">
        <span class="brand-mark">NW</span>
        <div>
          <h1>Two-factor verification</h1>
          <p class="subtitle">Signed in as {html.escape(email)}</p>
        </div>
      </div>
      <div class="mfa-preview" id="authenticator-preview" data-testid="authenticator-preview">
        <div class="mfa-preview-label">Authenticator app preview</div>
        <div class="mfa-preview-account">Northwind SSO · {html.escape(email)}</div>
        <div class="mfa-code" id="mfa-code">{html.escape(mfa_code)}</div>
      </div>
      {err_html}
      <form method="POST" action="/mfa" class="auth-form">
        <input type="hidden" name="challenge" value="{html.escape(challenge_id)}">
        <label class="field">
          <span>6-digit verification code</span>
          <input type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" required>
        </label>
        <button type="submit" class="btn-primary">Verify and continue</button>
      </form>
    </section>
  </main>
</body>
</html>"""


def render_session_expired_page():
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Session expired — Keystone Admin Vault</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">Keystone Admin Vault</div>
      <div class="user-pill">Session expired</div>
    </div>
  </header>
  <main class="container">
    <div class="session-banner" role="alert">
      <span>Your session expired. Sign in again to continue.</span>
      <a class="btn-primary" href="{REAUTH_URL}">Sign in again</a>
    </div>
  </main>
</body>
</html>"""


class VaultHandler(Handler):
    def redirect_with_cookie(self, location, cookie_header):
        self.send_response(303)
        self.send_header("Location", self.offset_ports(location))
        self.send_header("Set-Cookie", cookie_header)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def auth_state_locked(self):
        token = get_cookie(self, "vault_auth")
        if not token:
            return "none", None
        if token in STATE["active_tokens"]:
            return "valid", token
        if token in STATE["expired_tokens"]:
            return "expired", token
        return "none", None

    def auth_state(self):
        with LOCK:
            return self.auth_state_locked()

    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/callback":
            code = self.query.get("code", "")
            with LOCK:
                entry = STATE["auth_codes"].pop(code, None)
                if not entry:
                    return self.redirect(LOGIN_URL)
                STATE["auth_sessions_issued"] += 1
                if STATE["expiry_triggered"]:
                    STATE["reauth_count"] += 1
                token = secrets.token_hex(20)
                STATE["active_tokens"][token] = {
                    "email": entry["email"],
                    "expires_after_first_write": not STATE["expiry_triggered"],
                    "created_at_ms": now_ms(),
                }
            return self.redirect_with_cookie("/", f"vault_auth={token}; Path=/; HttpOnly; SameSite=Lax")
        if path == "/api/state":
            with LOCK:
                status, token = self.auth_state_locked()
                if status == "expired":
                    return self.send(401, {"error": "session_expired", "reauth_url": REAUTH_URL})
                if status != "valid":
                    return self.send(401, {"error": "unauthenticated", "login_url": LOGIN_URL})
                sess = STATE["active_tokens"][token]
                payload = {
                    "user": sess["email"],
                    "keys": copy.deepcopy(STATE["keys"]),
                    "tokens": copy.deepcopy(STATE["tokens"]),
                }
            return self.send(200, payload)
        if path in ("/", "/index.html"):
            status, _ = self.auth_state()
            if status == "expired":
                return self.html(401, render_session_expired_page())
            if status != "valid":
                return self.redirect(LOGIN_URL)
            return GUARD.render_page(self, (HERE / "fixture" / "vault" / "index.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/api/reset":
            reset_state()
            return self.send(200, {"ok": True})
        if path not in ("/api/keys/rotate", "/api/tokens/revoke"):
            return self.send(404, {"error": "not found"})
        raw = self.body_bytes()
        record = GUARD.verify_write(self, raw)
        if record["kind"] == "rejected":
            return GUARD.reject(self, record)
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.send(400, {"error": "Invalid JSON body"})
        if path == "/api/keys/rotate":
            key_id = str(body.get("key_id") or "").strip()
            with LOCK:
                status, token = self.auth_state_locked()
                if status == "expired":
                    return self.send(401, {"error": "session_expired", "reauth_url": REAUTH_URL})
                if status != "valid":
                    return self.send(401, {"error": "unauthenticated", "login_url": LOGIN_URL})
                key = next((k for k in STATE["keys"] if k["id"] == key_id), None)
                if not key:
                    return self.send(404, {"error": "Unknown signing key"})
                key["version"] += 1
                key["updated"] = "2026-11-06"
                record_mutation_locked()
                maybe_expire_first_session_locked(token)
                payload = {
                    "ok": True,
                    "key": copy.deepcopy(key),
                    "keys": copy.deepcopy(STATE["keys"]),
                    "tokens": copy.deepcopy(STATE["tokens"]),
                }
            return self.send(200, payload)
        token_id = str(body.get("token_id") or "").strip()
        with LOCK:
            status, token = self.auth_state_locked()
            if status == "expired":
                return self.send(401, {"error": "session_expired", "reauth_url": REAUTH_URL})
            if status != "valid":
                return self.send(401, {"error": "unauthenticated", "login_url": LOGIN_URL})
            tok = next((t for t in STATE["tokens"] if t["id"] == token_id), None)
            if not tok:
                return self.send(404, {"error": "Unknown API token"})
            if tok["status"] == "Revoked":
                return self.send(409, {"error": "Token already revoked"})
            tok["status"] = "Revoked"
            record_mutation_locked()
            maybe_expire_first_session_locked(token)
            payload = {
                "ok": True,
                "token": copy.deepcopy(tok),
                "keys": copy.deepcopy(STATE["keys"]),
                "tokens": copy.deepcopy(STATE["tokens"]),
            }
        return self.send(200, payload)


class SsoHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path in ("/", "/login"):
            return_to = validate_return_to(self.query.get("return_to", ""))
            reauth = self.query.get("reauth") == "1"
            return self.html(200, render_sso_login(return_to, reauth=reauth))
        if path == "/mfa":
            cid = self.query.get("challenge", "")
            with LOCK:
                ch = STATE["mfa_challenges"].get(cid)
            if not ch:
                return self.redirect(LOGIN_URL)
            return self.html(200, render_sso_mfa(cid, ch["code"], ch["email"]))
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/login":
            form = self.body_form()
            email = str(form.get("email") or "").strip()
            password = str(form.get("password") or "")
            return_to = validate_return_to(form.get("return_to", ""))
            if email.lower() != SSO_EMAIL or password != SSO_PASSWORD:
                return self.html(401, render_sso_login(return_to, error="Invalid email or password.", email=email))
            with LOCK:
                cid = secrets.token_hex(16)
                code = next_mfa_code_locked()
                STATE["mfa_challenges"][cid] = {"code": code, "return_to": return_to, "email": SSO_EMAIL}
            return self.redirect(f"http://127.0.0.1:{SSO_PORT}/mfa?challenge={cid}")
        if path == "/mfa":
            form = self.body_form()
            cid = str(form.get("challenge") or "").strip()
            entered = "".join(str(form.get("code") or "").split())
            with LOCK:
                ch = STATE["mfa_challenges"].get(cid)
                if not ch:
                    return self.redirect(LOGIN_URL)
                if entered != ch["code"]:
                    return self.html(401, render_sso_mfa(cid, ch["code"], ch["email"], error="Invalid verification code. Check the Authenticator app preview and try again."))
                STATE["mfa_challenges"].pop(cid, None)
                auth_code = secrets.token_hex(16)
                STATE["auth_codes"][auth_code] = {"email": ch["email"], "issued_at_ms": now_ms()}
            return self.redirect(f"http://127.0.0.1:{VAULT_PORT}/callback?code={auth_code}")
        return self.send(404, {"error": "not found"})


reset_state()

if __name__ == "__main__":
    fixture = HERE / "fixture"
    serve_forever(
        [(VAULT_PORT, VaultHandler, fixture / "vault"), (SSO_PORT, SsoHandler, fixture / "sso")],
        f"vault http://127.0.0.1:{VAULT_PORT}/ sso http://127.0.0.1:{SSO_PORT}/login",
    )
