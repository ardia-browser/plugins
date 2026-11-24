import hashlib
import json
import os
import re
import secrets
import urllib.error
import urllib.request
from urllib.parse import urlencode

CLICK = "click:1:50"
PORT_OFFSET = int(os.environ.get("BENCH_PORT_OFFSET") or 0)


def base(port):
    return f"http://127.0.0.1:{port + PORT_OFFSET}"


def sha256_hex(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def http(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def get_json(url):
    status, raw, _ = http("GET", url)
    return status, json.loads(raw or b"null")


class Session:
    def __init__(self, origin, page="/"):
        self.origin = origin
        status, html, headers = http("GET", origin + page)
        assert status == 200, (origin + page, status)
        self.cookie = headers["Set-Cookie"].split(";")[0]
        self.html = html.decode()
        self.csrf = re.search(r'<meta name="csrf-token" content="([0-9a-f]+)">', self.html).group(1)
        self.key = re.search(r'<meta name="app-build" content="([0-9a-f]+)">', self.html).group(1)[::-1]

    def signed(self, method, path, data, event=CLICK):
        nonce = secrets.token_hex(8)
        sig = sha256_hex(f"{self.key}|{self.csrf}|{nonce}|{method}|{path}|{sha256_hex(data)}|{event}")[:32]
        return {"Cookie": self.cookie, "Content-Type": "application/json", "X-CSRF-Token": self.csrf,
                "X-Req-Nonce": nonce, "X-Req-Sig": sig, "X-UI-Evt": event}

    def post(self, path, body, event=CLICK):
        data = json.dumps(body).encode()
        status, raw, _ = http("POST", self.origin + path, data, self.signed("POST", path, data, event))
        return status, json.loads(raw or b"null")

    def post_form(self, path, form, event=CLICK):
        fields = {k: str(v) for k, v in form.items()}
        pairs = [[k, fields[k]] for k in sorted(fields)]
        payload = json.dumps(pairs, separators=(",", ":"), ensure_ascii=False).encode()
        nonce = secrets.token_hex(8)
        sig = sha256_hex(f"{self.key}|{self.csrf}|{nonce}|POST|{path}|{sha256_hex(payload)}|{event}")[:32]
        signed_form = dict(fields, _csrf=self.csrf, _nonce=nonce, _sig=sig, _evt=event)
        data = urlencode(signed_form).encode()
        req = urllib.request.Request(
            self.origin + path,
            data=data,
            method="POST",
            headers={"Cookie": self.cookie, "Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.read().decode(), r.geturl()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(), path


def unsigned_post(url, body):
    status, raw, _ = http("POST", url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return status


class Report:
    def __init__(self):
        self.failures = 0

    def __call__(self, name, ok, extra=""):
        self.failures += not ok
        print(f"{'PASS' if ok else 'FAIL'} {name}{' ' + str(extra) if extra and not ok else ''}")

    def leaks(self, payload, answers):
        text = json.dumps(payload).lower()
        return [a for a in answers if a.lower() in text]

    def finish(self):
        print(f"{'all checks passed' if not self.failures else f'{self.failures} check(s) failed'}")
        raise SystemExit(1 if self.failures else 0)
