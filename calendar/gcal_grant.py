#!/usr/bin/env python3
"""gcal_grant: sign one Google account in to kay-os's calendar access, once.

Opens Google's consent screen in the browser for the given account, catches
the answer on a loopback port, and stores the account's refresh token in
Doppler (kay-os/prd) as KAYOS_GCAL_<ACCOUNT>_REFRESH_TOKEN. Nothing secret is
printed or written to disk. Then it reads the account's calendar list and the
last 30 days of its main calendar, and prints counts, to prove the grant works.

The OAuth client is lossless's Desktop client in the Google Cloud project
mps-caldiy-sync, read from LOSSLESS_GOOGLE_OAUTH_KAYOS_CLIENT_JSON (run under
`doppler run`) or from ~/.config/kay-os/google/kay-os-desktop-client.json.

  doppler run --project kay-os --config prd -- python3 calendar/gcal_grant.py michael@learnstart.vc

Standard library only.
"""

import argparse
import base64
import datetime
import hashlib
import http.server
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
]
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/calendar/v3"
CLIENT_FILE = Path.home() / ".config/kay-os/google/kay-os-desktop-client.json"
DOPPLER = ["--project", "kay-os", "--config", "prd", "--no-check-version"]


def secret_name(address):
    """KAYOS_GCAL_<LABEL>_REFRESH_TOKEN, labelled like the mail passwords.

    The label is the domain's first part (learnstart.vc -> LEARNSTART), except
    for consumer Gmail, where it's GMAIL.
    """
    local, _, domain = address.lower().partition("@")
    if not domain:
        raise ValueError(f"not an email address: {address}")
    first = domain.split(".")[0]
    label = re.sub(r"[^A-Z0-9]+", "_", first.upper()).strip("_")
    return f"KAYOS_GCAL_{label}_REFRESH_TOKEN"


def load_client():
    raw = os.environ.get("LOSSLESS_GOOGLE_OAUTH_KAYOS_CLIENT_JSON")
    data = json.loads(raw) if raw else json.loads(CLIENT_FILE.read_text())
    client = data.get("installed") or data.get("web")
    if not client:
        raise SystemExit("The client JSON has neither an 'installed' nor a 'web' section.")
    return client["client_id"], client["client_secret"]


def auth_request(client_id, redirect_uri, address, challenge, state):
    return AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",  # ask for a refresh token
        "prompt": "consent",       # and always get one, even on a repeat grant
        "login_hint": address,
        "include_granted_scopes": "true",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    })


def wait_for_code(state, timeout=600):
    """Serve one request on a free loopback port; return (redirect_uri, code)."""
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if query.get("state", [None])[0] != state:
                self.send_error(400, "Unexpected state")
                return
            result["code"] = query.get("code", [None])[0]
            result["error"] = query.get("error", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            message = "Signed in. You can close this tab." if result["code"] else f"Google said: {result['error']}"
            self.wfile.write(f"<p>kay-os calendar: {message}</p>".encode())

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = timeout
    redirect_uri = f"http://127.0.0.1:{server.server_address[1]}"
    return server, redirect_uri, result


def open_browser(url):
    # A parent process (the Claude Code Nix wrapper, for one) may set
    # LD_LIBRARY_PATH to libraries the browser can't load, so it dies on launch.
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    opener = "xdg-open" if sys.platform.startswith("linux") else "open"
    try:
        subprocess.Popen([opener, url], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except OSError:
        webbrowser.open(url)


def post_form(url, fields):
    body = urllib.parse.urlencode(fields).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=60) as response:
        return json.load(response)


def get_json(path, token, **params):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def store_in_doppler(name, value):
    subprocess.run(["doppler", "secrets", "set", name, "--silent", *DOPPLER],
                   input=value, text=True, check=True, capture_output=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("address", help="the Google account to sign in, e.g. michael@learnstart.vc")
    args = parser.parse_args()
    address = args.address.lower()
    name = secret_name(address)
    client_id, client_secret = load_client()

    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    server, redirect_uri, result = wait_for_code(state)
    url = auth_request(client_id, redirect_uri, address, challenge, state)

    print(f"Opening Google sign-in for {address}. If no browser opens, visit:\n\n{url}\n", flush=True)
    threading.Thread(target=open_browser, args=(url,), daemon=True).start()
    server.handle_request()
    server.server_close()
    if not result.get("code"):
        sys.exit(f"No grant: {result.get('error') or 'timed out waiting for the browser'}")

    tokens = post_form(TOKEN_URL, {
        "code": result["code"], "client_id": client_id, "client_secret": client_secret,
        "redirect_uri": redirect_uri, "grant_type": "authorization_code", "code_verifier": verifier,
    })
    refresh, access = tokens.get("refresh_token"), tokens.get("access_token")
    if not refresh:
        sys.exit("Google returned no refresh token. Remove kay-os's access at "
                 "myaccount.google.com/connections and run this again.")

    # Refuse to store a token for a different account than the one asked for:
    # Google's account picker makes it easy to pick the wrong one.
    calendars = get_json("/users/me/calendarList", access, maxResults=250).get("items", [])
    primary = next((c for c in calendars if c.get("primary")), {})
    if primary.get("id", "").lower() != address:
        sys.exit(f"Signed in as {primary.get('id') or 'an unknown account'}, not {address}. Nothing stored.")

    store_in_doppler(name, refresh)
    now = datetime.datetime.now(datetime.timezone.utc)
    events = get_json(f"/calendars/{urllib.parse.quote(address)}/events", access,
                      timeMin=(now - datetime.timedelta(days=30)).isoformat(), timeMax=now.isoformat(),
                      singleEvents="true", maxResults=2500).get("items", [])
    with_attendees = sum(1 for e in events if e.get("attendees"))
    print(f"Stored {name} in Doppler kay-os/prd.")
    print(f"{address}: {len(calendars)} calendars; last 30 days on the main calendar: "
          f"{len(events)} events, {with_attendees} with attendees.")


if __name__ == "__main__":
    main()
