"""Minimal Concept2 Logbook API client: one-time OAuth setup, token refresh, and posting a result.

Only needed if you want pm5_logger.py to post your rows to the Concept2 Logbook.

One-time setup:
  1. Register an API application with Concept2 (https://log.concept2.com/developers/documentation/)
     and set its redirect URI to http://localhost:8766.
  2. Copy .env.example to .env and fill in CONCEPT2_CLIENT_ID and CONCEPT2_CLIENT_SECRET.
  3. Run `python concept2.py auth`. A browser opens; approve; the refresh token is saved to .env.
  4. Check it with `python concept2.py whoami`.

Concept2 issues a new refresh token every time one is used and revokes the old one, so this
module writes each new token back to .env. If you ever see "The refresh token is invalid",
the saved token was lost; run `python concept2.py auth` again.
"""
import json
import os
import secrets
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
ENV = ROOT / ".env"
load_dotenv(ENV, override=True)

API = "https://log.concept2.com/api"
AUTHORIZE_URL = "https://log.concept2.com/oauth/authorize"
TOKEN_URL = "https://log.concept2.com/oauth/access_token"
SCOPES = "user:read,results:write"   # write implies read; a refresh asking for less narrows the token
REDIRECT = os.environ.get("CONCEPT2_REDIRECT_URI", "http://localhost:8766")


class NotConfigured(RuntimeError):
    pass


def _env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise NotConfigured(f"{key} is not set. Copy .env.example to .env and fill it in (see concept2.py).")
    return val


def _save_env(key: str, value: str) -> None:
    """Rewrite one KEY in .env atomically: a temp file renamed over the original, so a
    crash mid-write can't leave a truncated .env with every credential gone."""
    lines = ENV.read_text().splitlines() if ENV.exists() else []
    lines = [l for l in lines if not l.startswith(f"{key}=")] + [f"{key}={value}"]
    fd, tmp = tempfile.mkstemp(prefix=".env.", dir=ROOT)
    try:
        with os.fdopen(fd, "w") as f:
            f.write("\n".join(lines) + "\n")
        os.chmod(tmp, 0o600)   # it holds your client secret and refresh token
        os.replace(tmp, ENV)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    os.environ[key] = value


def _token_request(data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode()
    try:
        return json.loads(urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=body)).read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"Concept2 token request failed (HTTP {e.code}): {detail}") from None


def auth() -> None:
    """Browser OAuth flow; saves CONCEPT2_REFRESH_TOKEN to .env."""
    cid, secret = _env("CONCEPT2_CLIENT_ID"), _env("CONCEPT2_CLIENT_SECRET")
    state = secrets.token_urlsafe(16)
    url = (f"{AUTHORIZE_URL}?client_id={urllib.parse.quote(cid, safe='')}&response_type=code"
           f"&redirect_uri={urllib.parse.quote(REDIRECT, safe='')}&scope={urllib.parse.quote(SCOPES, safe='')}"
           f"&state={state}")
    got = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            qs = parse_qs(urlparse(self.path).query)
            if "code" in qs and qs.get("state") == [state]:
                got["code"] = qs["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<h1>Done. You can close this tab.</h1>")
            else:
                self.send_response(400)
                self.end_headers()

        def log_message(self, *a):
            pass

    print(f"Opening {url}")
    webbrowser.open(url)
    port = urlparse(REDIRECT).port or 80
    server = HTTPServer(("localhost", port), Handler)
    while "code" not in got:
        server.handle_request()
    resp = _token_request({"client_id": cid, "client_secret": secret, "code": got["code"],
                           "grant_type": "authorization_code", "redirect_uri": REDIRECT, "scope": SCOPES})
    _save_env("CONCEPT2_REFRESH_TOKEN", resp["refresh_token"])
    print("Saved CONCEPT2_REFRESH_TOKEN to .env.")


def access_token() -> str:
    """Exchange the saved refresh token for an access token, keeping the rotated refresh token."""
    refresh = _env("CONCEPT2_REFRESH_TOKEN")
    resp = _token_request({"client_id": _env("CONCEPT2_CLIENT_ID"), "client_secret": _env("CONCEPT2_CLIENT_SECRET"),
                           "grant_type": "refresh_token", "refresh_token": refresh, "scope": SCOPES})
    if resp.get("refresh_token") and resp["refresh_token"] != refresh:
        _save_env("CONCEPT2_REFRESH_TOKEN", resp["refresh_token"])
    return resp["access_token"]


def _request(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    headers = {"Authorization": f"Bearer {access_token()}", "Accept": "application/json"}
    data = None
    if payload is not None:
        data, headers["Content-Type"] = json.dumps(payload).encode(), "application/json"
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def post_result(payload: dict) -> tuple[int, dict]:
    """POST one result. Returns (status, body): 201 created, 409 duplicate, 422 validation errors."""
    return _request("POST", "/users/me/results", payload)


def whoami() -> None:
    status, body = _request("GET", "/users/me")
    user = body.get("data") or {}
    print(f"HTTP {status}: logged in as {user.get('username') or user.get('first_name') or '?'}" if status == 200
          else f"HTTP {status}: {body}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if cmd == "auth":
            auth()
        elif cmd == "whoami":
            whoami()
        else:
            sys.exit("usage: python concept2.py auth | whoami")
    except RuntimeError as e:
        sys.exit(str(e))
