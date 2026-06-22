"""
Gmail API email sender for ThreadNotes (sends over HTTPS — no SMTP ports).

IMPORTANT: this uses an OAuth 2.0 *Desktop app* client (credentials.json), NOT a
service account. A service account cannot send as a consumer @gmail.com address.
First run locally to mint token.json (browser consent); on Render, ship both
credentials.json and token.json as Secret Files — the refresh token keeps it alive.
"""
import os
import base64
import asyncio
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]

CREDENTIALS_PATH = os.getenv("GMAIL_CREDENTIALS_PATH", "credentials.json")
TOKEN_PATH = os.getenv("GMAIL_TOKEN_PATH", "token.json")
SENDER = os.getenv("EMAIL_SENDER", "threadnotes12@gmail.com")

_service = None


def _save_token(creds: Credentials) -> None:
    """Persist the token — best-effort. On Render, secret files are read-only;
    the refresh still works in-memory, so a failed write must not break sending."""
    try:
        with open(TOKEN_PATH, "w") as f:
            f.write(creds.to_json())
    except OSError:
        pass


def _load_credentials(allow_interactive: bool = False) -> Credentials:
    """Return valid OAuth creds. Refreshes silently when possible; only runs the
    browser flow when allow_interactive=True (local setup), never on the server."""
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        _save_token(creds)
        return creds

    if allow_interactive:
        flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
        creds = flow.run_local_server(port=0)
        _save_token(creds)
        return creds

    raise RuntimeError(
        "No valid Gmail token. Run `python email_service.py` locally once to "
        "create token.json, then deploy it as a Render secret file."
    )


def _get_service():
    global _service
    if _service is None:
        creds = _load_credentials(allow_interactive=False)
        _service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    return _service


def _send_sync(to_email: str, subject: str, html_content: str) -> dict:
    """Blocking send (the google client is synchronous)."""
    service = _get_service()
    msg = MIMEMultipart("alternative")
    msg["To"] = to_email
    msg["From"] = SENDER
    msg["Subject"] = subject
    msg.attach(MIMEText(html_content, "html"))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return service.users().messages().send(userId="me", body={"raw": raw}).execute()


async def send_meeting_email(to_email: str, subject: str, html_content: str) -> dict:
    """Send an HTML email. Never raises — returns a result dict so a failure
    can't crash the request handler."""
    try:
        result = await asyncio.to_thread(_send_sync, to_email, subject, html_content)
        msg_id = result.get("id")
        return {"success": True, "id": msg_id}
    except HttpError as e:
        return {"success": False, "error": f"Gmail API error: {e}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    _load_credentials(allow_interactive=True)
