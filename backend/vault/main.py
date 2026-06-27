from datetime import datetime, timezone, timedelta
import asyncio
import base64
import json
import logging
import os
import re
import secrets
import traceback
import uuid
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Dict, List

import bcrypt
import jwt
import httpx
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr
from azure.cosmos import CosmosClient
from dotenv import load_dotenv

load_dotenv()

SECRET_KEY = os.getenv("JWT_SECRET", "threadnotes-super-secret-key")
ALGORITHM = "HS256"
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY", "").strip()
AZURE_SPEECH_REGION = os.getenv("AZURE_SPEECH_REGION", "").strip()

COSMOS_ENDPOINT = os.getenv("COSMOS_ENDPOINT")
COSMOS_KEY = os.getenv("COSMOS_KEY")
DATABASE_NAME = os.getenv("COSMOS_DATABASE")
USERS_CONTAINER = os.getenv("COSMOS_USERS_CONTAINER", "users")

app = FastAPI(
    title="ThreadNotes Cloud Vault",
    description="Lightweight secure vault for Auth + Azure Speech SDK tokens.",
    version="1.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
_env_log = logging.getLogger("threadnotes.env")


@app.on_event("startup")
def _diagnose_env():
    """Log presence + length of critical env vars and the presence/size of the
    Gmail secret files at startup. Never logs the actual secret values or file
    contents — only whether they're set/exist and how large they are."""
    for key in (
        "GMAIL_SENDER",
        "JWT_SECRET",
        "COSMOS_ENDPOINT",
        "COSMOS_KEY",
        "COSMOS_DATABASE",
        "AZURE_SPEECH_KEY",
        "AZURE_SPEECH_REGION",
    ):
        val = os.getenv(key)
        _env_log.info(
            "ENV %-20s present=%-5s length=%s",
            key,
            bool(val),
            len(val) if val else 0,
        )

    # Gmail OAuth secret files (Render Secret Files). Log existence + size only.
    for label, path in (
        ("credentials.json", GMAIL_CREDENTIALS_PATH),
        ("token.json", GMAIL_TOKEN_PATH),
    ):
        exists = os.path.exists(path)
        size = os.path.getsize(path) if exists else 0
        _env_log.info(
            "FILE %-16s path=%s exists=%-5s bytes=%s",
            label,
            path,
            exists,
            size,
        )


security = HTTPBearer(auto_error=True)

otp_storage: Dict[str, dict] = {}
signup_otp_storage: Dict[str, dict] = {}
# email -> datetime when the verified status expires (10 min after OTP verify).
verified_emails: Dict[str, datetime] = {}

_users_cont = None


def get_users_container():
    global _users_cont
    if _users_cont is None:
        if not COSMOS_ENDPOINT or not COSMOS_KEY or not DATABASE_NAME:
            raise HTTPException(status_code=500, detail="Cosmos DB configuration is missing.")
        client = CosmosClient(COSMOS_ENDPOINT, COSMOS_KEY)
        database = client.get_database_client(DATABASE_NAME)
        _users_cont = database.get_container_client(USERS_CONTAINER)
    return _users_cont


def build_openai_client():
    from openai import OpenAI, AzureOpenAI

    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
    key = (os.getenv("AZURE_OPENAI_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
    if not key:
        raise HTTPException(status_code=500, detail="OpenAI/Azure OpenAI key is missing in the vault.")
    # timeout=1500s gives a long (~23 min) chunk enough time to fully diarize
    # without the client cutting it off mid-process. max_retries=0 so a failure
    # surfaces IMMEDIATELY with a clear reason instead of silently re-uploading
    # and re-processing the whole chunk 2-3 more times (which looked like a hang).
    if endpoint:
        return AzureOpenAI(
            api_key=key,
            api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2025-04-01-preview").strip(),
            azure_endpoint=endpoint,
            timeout=1500,
            max_retries=0,
        )
    return OpenAI(api_key=key, timeout=1500, max_retries=0)


def interpolate_words(text: str, start: float, end: float) -> list:
    words = text.split()
    if not words:
        return []
    weights = [len(w) + 1 + (5 if w.endswith((".", "?", "!", ",", ";", "-")) else 0) for w in words]
    total = sum(weights) or 1
    duration = max(0.0, end - start)
    out, cursor = [], start
    for w, weight in zip(words, weights):
        cursor_end = cursor + duration * (weight / total)
        out.append({"word": w, "start": round(cursor, 3), "end": round(min(end, cursor_end), 3)})
        cursor = cursor_end
    if out:
        out[-1]["end"] = round(end, 3)
    return out


class UserSignup(BaseModel):
    name: str
    email: EmailStr
    password: str


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class OTPRequest(BaseModel):
    email: EmailStr


class OTPVerifyRequest(BaseModel):
    email: EmailStr
    otp: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    otp: str
    new_password: str


class DeleteAccountRequest(BaseModel):
    confirm_password: str


OTP_TTL = timedelta(minutes=5)
# How long a verified email stays valid for signup after OTP verification.
VERIFIED_TTL = timedelta(minutes=10)


def _generate_otp() -> str:
    """Cryptographically secure 6-digit OTP (000000–999999)."""
    return f"{secrets.randbelow(10**6):06d}"


GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"]
# backend/ dir = one level up from this file (backend/vault/main.py -> backend/),
# resolved from __file__ so it doesn't depend on the process working directory.
# credentials.json / token.json physically live in backend/. Both paths stay
# env-overridable (e.g. GMAIL_TOKEN_PATH=/etc/secrets/token.json on Render).
_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GMAIL_CREDENTIALS_PATH = os.getenv(
    "GMAIL_CREDENTIALS_PATH", os.path.join(_BACKEND_DIR, "credentials.json")
)
GMAIL_TOKEN_PATH = os.getenv(
    "GMAIL_TOKEN_PATH", os.path.join(_BACKEND_DIR, "token.json")
)
_gmail_service = None


def _build_gmail_service():
    """Build an authenticated Gmail API client from on-disk OAuth secret files.

    Loads the authorized-user token from token.json (which carries the refresh
    token + client id/secret minted once via the OAuth consent flow). Refreshes
    silently in-memory when the access token is expired. We never write the
    refreshed token back — on Render the secret files are read-only, and the
    in-memory refresh is enough. No interactive/browser flow on the server.
    Imports are lazy so a missing google lib can't crash app startup.

    Aggressive logging: any failure (FileNotFoundError, RefreshError from an
    expired/revoked token, etc.) is printed with a full traceback to the server
    logs before an HTTPException is raised, so the real cause is visible.
    """
    try:
        print(f"[GMAIL] building service — token path: {GMAIL_TOKEN_PATH}")
        if not os.path.exists(GMAIL_TOKEN_PATH):
            raise HTTPException(
                status_code=500,
                detail=f"Secret file not found at {GMAIL_TOKEN_PATH}",
            )

        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build

        creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_PATH, GMAIL_SCOPES)

        if not creds.valid:
            if creds.expired and creds.refresh_token:
                print("[GMAIL] access token expired — refreshing via refresh_token")
                creds.refresh(Request())  # in-memory only; secret file stays read-only
            else:
                raise HTTPException(
                    status_code=500,
                    detail="Gmail credentials are invalid and cannot be refreshed. "
                    "Regenerate token.json and re-upload it as a Render secret file.",
                )

        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        print("[GMAIL] service built successfully")
        return service
    except Exception as e:
        traceback.print_exc()
        print(f"CRITICAL GMAIL ERROR: {repr(e)}")
        # Preserve descriptive HTTPExceptions (missing file / unrefreshable creds);
        # wrap anything else (RefreshError, FileNotFoundError, ...) with its repr.
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(
            status_code=500, detail=f"Gmail service initialization failed: {repr(e)}"
        )


def _get_gmail_service():
    """Cache the Gmail client; google-auth auto-refreshes the token on expiry."""
    global _gmail_service
    if _gmail_service is None:
        _gmail_service = _build_gmail_service()
    return _gmail_service


def send_otp_email(target_email: str, otp: str, subject_prefix: str):
    try:
        service = _get_gmail_service()  # may raise HTTP 500 (creds/file issues)

        msg = MIMEMultipart()
        sender = os.getenv("GMAIL_SENDER")
        if sender:
            msg["From"] = sender
        msg["To"] = target_email
        msg["Subject"] = f"ThreadNotes - {subject_prefix} OTP"
        body = f"Your OTP for {subject_prefix} is: {otp}\n\nPlease do not share this with anyone."
        msg.attach(MIMEText(body, "plain"))

        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        result = service.users().messages().send(
            userId="me", body={"raw": raw}
        ).execute()
        print(f"[GMAIL] OTP email sent to {target_email} — id={result.get('id')}")
    except Exception as e:
        traceback.print_exc()
        print(f"CRITICAL GMAIL ERROR: {repr(e)}")
        # Preserve a descriptive HTTPException from _get_gmail_service; otherwise
        # surface the underlying send error (HttpError, RefreshError, ...).
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(
            status_code=502, detail=f"Failed to send email via Gmail API: {repr(e)}"
        )


def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        if not isinstance(payload, dict):
            raise HTTPException(status_code=401, detail="Invalid authentication token")
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid authentication token")


@app.post("/send-signup-otp")
def send_signup_otp(req: OTPRequest):
    users_cont = get_users_container()
    exists = list(
        users_cont.query_items(
            "SELECT * FROM c WHERE c.email = @email",
            parameters=[{"name": "@email", "value": req.email}],
            enable_cross_partition_query=True,
        )
    )
    if exists:
        raise HTTPException(status_code=400, detail="Email already registered. Please log in.")

    otp = _generate_otp()
    signup_otp_storage[req.email] = {
        "otp": otp,
        "expires_at": datetime.now(timezone.utc) + OTP_TTL,
    }
    send_otp_email(req.email, otp, "Signup Verification")
    return {"status": "success", "message": "Verification OTP sent successfully."}


@app.post("/verify-signup-otp")
def verify_signup_otp(req: OTPVerifyRequest):
    entry = signup_otp_storage.get(req.email)
    if not entry or entry.get("otp") != req.otp:
        raise HTTPException(status_code=400, detail="Invalid verification OTP.")
    if datetime.now(timezone.utc) >= entry["expires_at"]:
        signup_otp_storage.pop(req.email, None)
        raise HTTPException(
            status_code=400,
            detail="Verification OTP has expired. Please request a new one.",
        )

    # Mark the email verified for a limited window so the user doesn't have to
    # sign up immediately. The OTP itself is single-use — consume it now.
    verified_emails[req.email] = datetime.now(timezone.utc) + VERIFIED_TTL
    signup_otp_storage.pop(req.email, None)
    return {"status": "success", "message": "Email verified successfully."}


@app.post("/signup")
def signup(user: UserSignup):
    # Require a still-valid email verification (set by /verify-signup-otp).
    verified_until = verified_emails.get(user.email)
    if not verified_until or datetime.now(timezone.utc) >= verified_until:
        verified_emails.pop(user.email, None)
        raise HTTPException(
            status_code=403,
            detail="Email not verified. Please verify your OTP first.",
        )

    users_cont = get_users_container()
    exists = list(
        users_cont.query_items(
            "SELECT * FROM c WHERE c.email = @email",
            parameters=[{"name": "@email", "value": user.email}],
            enable_cross_partition_query=True,
        )
    )
    if exists:
        raise HTTPException(status_code=400, detail="Email already registered")

    hashed_pw = bcrypt.hashpw(user.password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    user_doc = {
        "id": str(uuid.uuid4()),
        "tenantId": str(uuid.uuid4()),
        "name": user.name,
        "email": user.email,
        "password": hashed_pw,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    users_cont.create_item(user_doc)
    # Single-use: consume the verification so it can't seed another signup.
    verified_emails.pop(user.email, None)
    signup_otp_storage.pop(user.email, None)
    return {"status": "success", "message": "Account created"}


@app.post("/login")
def login(user: UserLogin):
    users_cont = get_users_container()
    user_list = list(
        users_cont.query_items(
            "SELECT * FROM c WHERE c.email = @email",
            parameters=[{"name": "@email", "value": user.email}],
            enable_cross_partition_query=True,
        )
    )
    if not user_list or not bcrypt.checkpw(
        user.password.encode("utf-8"), user_list[0]["password"].encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token_data = {
        "sub": user_list[0]["email"],
        "tenantId": user_list[0]["tenantId"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=24),
    }
    return {
        "access_token": jwt.encode(token_data, SECRET_KEY, algorithm=ALGORITHM),
        "token_type": "bearer",
        "name": user_list[0]["name"],
    }


@app.post("/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    users_cont = get_users_container()
    user_list = list(
        users_cont.query_items(
            "SELECT * FROM c WHERE c.email = @email",
            parameters=[{"name": "@email", "value": req.email}],
            enable_cross_partition_query=True,
        )
    )
    # Always return the same generic response so callers cannot tell whether the
    # email is registered (prevents user enumeration).
    generic_response = {
        "status": "success",
        "message": "If an account exists for that email, a reset OTP has been sent.",
    }
    if not user_list:
        return generic_response

    otp = _generate_otp()
    otp_storage[req.email] = {
        "otp": otp,
        "expires_at": datetime.now(timezone.utc) + OTP_TTL,
    }
    send_otp_email(req.email, otp, "Password Reset")
    return generic_response


@app.post("/reset-password")
def reset_password(req: ResetPasswordRequest):
    entry = otp_storage.get(req.email)
    if not entry or entry.get("otp") != req.otp:
        raise HTTPException(status_code=400, detail="Invalid OTP.")
    if datetime.now(timezone.utc) >= entry["expires_at"]:
        # Expired — clear it so it can't be retried.
        otp_storage.pop(req.email, None)
        raise HTTPException(
            status_code=400, detail="OTP has expired. Please request a new one."
        )

    users_cont = get_users_container()
    user_list = list(
        users_cont.query_items(
            "SELECT * FROM c WHERE c.email = @email",
            parameters=[{"name": "@email", "value": req.email}],
            enable_cross_partition_query=True,
        )
    )
    if not user_list:
        raise HTTPException(status_code=404, detail="User not found")

    user_doc = user_list[0]
    user_doc["password"] = bcrypt.hashpw(
        req.new_password.encode("utf-8"), bcrypt.gensalt()
    ).decode("utf-8")
    users_cont.upsert_item(user_doc)
    # Invalidate the OTP immediately after a successful reset to prevent reuse.
    otp_storage.pop(req.email, None)
    return {"status": "success", "message": "Password updated successfully!"}


def _delete_user_transcripts(user_id: str) -> int:
    """Best-effort cascade: remove any cloud transcripts owned by this user.

    Transcripts are now stored locally on the user's PC, so the cloud
    transcripts container typically does not exist. This stays defensive: if a
    transcripts container IS present (legacy data / forward-compat), it deletes
    every doc whose userId matches; if not, it returns 0 without failing the
    account deletion. We never create the container here.
    """
    if not (COSMOS_ENDPOINT and COSMOS_KEY and DATABASE_NAME):
        return 0
    try:
        client = CosmosClient(COSMOS_ENDPOINT, COSMOS_KEY)
        database = client.get_database_client(DATABASE_NAME)
        container = database.get_container_client(
            os.getenv("COSMOS_TRANSCRIPTS_CONTAINER", "transcripts")
        )
        items = list(
            container.query_items(
                "SELECT c.id, c.userId FROM c WHERE c.userId = @uid",
                parameters=[{"name": "@uid", "value": user_id}],
                enable_cross_partition_query=True,
            )
        )
        deleted = 0
        for it in items:
            try:
                container.delete_item(
                    item=it["id"], partition_key=it.get("userId", user_id)
                )
                deleted += 1
            except Exception:
                pass
        return deleted
    except Exception:
        # Container missing or any other error — nothing to cascade.
        return 0


@app.delete("/delete-account")
def delete_account(
    req: DeleteAccountRequest,
    user: dict = Depends(get_current_user),
):
    email = user.get("sub")
    if not email:
        raise HTTPException(status_code=401, detail="Invalid authentication token")

    users_cont = get_users_container()
    user_list = list(
        users_cont.query_items(
            "SELECT * FROM c WHERE c.email = @email",
            parameters=[{"name": "@email", "value": email}],
            enable_cross_partition_query=True,
        )
    )
    if not user_list:
        raise HTTPException(status_code=404, detail="User not found")

    user_doc = user_list[0]

    # Re-verify the password to prevent accidental/malicious deletion.
    stored_hash = (user_doc.get("password") or "").encode("utf-8")
    if not stored_hash or not bcrypt.checkpw(
        req.confirm_password.encode("utf-8"), stored_hash
    ):
        raise HTTPException(status_code=401, detail="Incorrect password.")

    # Cascade: remove associated cloud transcripts (best-effort), then the user.
    deleted_transcripts = _delete_user_transcripts(email)

    try:
        # Resolve the container's partition key dynamically so delete_item works
        # regardless of whether it's /email, /id, /tenantId, etc.
        props = users_cont.read()
        pk_path = (props.get("partitionKey", {}).get("paths") or ["/id"])[0]
        pk_value = user_doc.get(pk_path.strip("/"), user_doc.get("id"))
        users_cont.delete_item(item=user_doc["id"], partition_key=pk_value)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete account: {exc}")

    # Drop any pending auth state for this email so nothing lingers.
    verified_emails.pop(email, None)
    otp_storage.pop(email, None)
    signup_otp_storage.pop(email, None)

    return {
        "status": "success",
        "message": "Account deleted.",
        "transcripts_deleted": deleted_transcripts,
    }


@app.get("/azure/token")
async def get_azure_speech_token(user: dict = Depends(get_current_user)):
    if not AZURE_SPEECH_KEY or not AZURE_SPEECH_REGION:
        raise HTTPException(status_code=500, detail="Azure Speech configuration is missing.")

    sts_url = f"https://{AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                sts_url,
                headers={
                    "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
                    "Content-Length": "0",
                },
            )
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Azure token request failed: {exc}")

    return {"token": response.text, "region": AZURE_SPEECH_REGION}


_NOISE_ANNOTATION = re.compile(
    r"^[\(\[\*]?\s*(breath|breathing|inhale|exhale|cough|sneeze|click|"
    r"clicks|noise|static|silence|music|laughter|laughs?|sigh)\s*[\)\]\*]?$",
    re.IGNORECASE,
)


def _is_noise_fragment(text: str) -> bool:
    """Heuristic: True for non-verbal noise that should not create a speaker.

    Catches (a) explicit non-verbal annotations like "(breath)" / "[cough]",
    and (b) fragments that carry no real characters — e.g. punctuation-only
    "...", "*" clicks, or "--". Uses Unicode-aware ``str.isalnum`` so genuine
    short words in any script (English "Hi"/"No", Hindi, etc.) pass through.
    """
    t = text.strip()
    if _NOISE_ANNOTATION.match(t):
        return True
    if not any(ch.isalnum() for ch in t):
        return True
    return False


def _create_diarized_transcription(client, deployment, safe_name, audio_bytes, mime):
    """Call the diarization model.

    NOTE: the gpt-4o-transcribe-diarize deployment REJECTS the `prompt`
    parameter (400 invalid_request_error), so we never send it — doing so only
    wasted a guaranteed-failed round-trip + an SDK retry on every single chunk.
    Speaker over-segmentation is instead handled downstream by the ghost-speaker
    filter (_merge_ghost_speakers / _identify_ghost_speakers), so dropping the
    prompt does NOT change the diarization output — it just removes the waste.
    """
    base = dict(
        model=deployment,
        file=(safe_name, audio_bytes, mime),
        response_format="diarized_json",
        extra_body={"chunking_strategy": "auto"},
    )
    try:
        return client.audio.transcriptions.create(**base)
    except Exception as exc:
        # Surface the ACTUAL Azure error body (status + payload), not just the
        # opaque httpx status line, so any real 400 reason is visible in logs.
        body = getattr(getattr(exc, "response", None), "text", None)
        status = getattr(getattr(exc, "response", None), "status_code", None)
        print(
            f"CRITICAL DIARIZE ERROR (status={status}): {exc}\n"
            f"Azure response body: {body}",
            flush=True,
        )
        traceback.print_exc()
        raise


def _friendly_diarize_error(exc: Exception) -> str:
    """Translate a raw transcription/diarization exception into a short, plain
    English sentence safe to show the end user — no stack traces, status codes,
    or SDK jargon. Used for BOTH live-recording and uploaded-file diarization
    (they share the /diarize/stream endpoint)."""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    name = type(exc).__name__.lower()
    msg = str(exc).lower()

    # Client cut the call off — the audio took longer than the time limit.
    if "timeout" in name or "timed out" in msg or status == 408:
        return (
            "This recording is too long to process in one go and timed out. "
            "Please try a shorter recording, or split it into smaller parts."
        )
    # Couldn't reach the transcription service at all.
    if "connection" in name or "connect" in msg:
        return (
            "We couldn't reach the transcription service. "
            "Please check your internet connection and try again."
        )
    # Service is overloaded / quota hit.
    if status == 429 or "rate limit" in msg or "ratelimit" in name:
        return (
            "The transcription service is busy right now. "
            "Please wait a minute and try again."
        )
    # Authentication / permission problems (config issue, not the user's fault).
    if status in (401, 403) or "authentication" in name or "permission" in name:
        return (
            "The transcription service rejected our credentials. "
            "Please contact support — this is a configuration issue, not your file."
        )
    # Bad input — usually audio too long for the model, or unsupported/corrupt.
    if status == 400 or "bad request" in msg or "invalid" in msg:
        if "duration" in msg or "1500" in msg or "too long" in msg:
            return (
                "This audio is too long for the transcription model. "
                "Please use a shorter recording or file."
            )
        return (
            "This audio couldn't be processed. It may be in an unsupported "
            "format or corrupted. Please try a different file."
        )
    # Anything else.
    return (
        "Something went wrong while transcribing this audio. "
        "Please try again in a moment."
    )


# --- Dynamic ghost-speaker cleanup ------------------------------------------
# A "ghost" is a speaker whose ENTIRE contribution to the recording is trivially
# small — a few words AND a very short total speaking time. These are the
# coughs / "Hmm" / "Yeah" crosstalk the model over-segments into new speakers.
# Thresholds are absolute per-speaker FLOORS (plus a relative check), NOT a cap
# on the number of speakers — a real 2/4/8-participant meeting keeps every
# genuine speaker no matter how many there are.
GHOST_MAX_WORDS = 3          # <= this many words total ...
GHOST_MAX_DURATION = 2.0     # ... AND <= this many seconds total => ghost
GHOST_RELATIVE_RATIO = 0.08  # also a ghost if < 8% of the busiest speaker's words


def _speaker_stats(segments: List[dict]) -> Dict[str, dict]:
    stats: Dict[str, dict] = {}
    for i, seg in enumerate(segments):
        sp = seg["speaker"]
        s = stats.setdefault(
            sp, {"words": 0, "duration": 0.0, "segments": 0, "first": i}
        )
        s["words"] += len(seg.get("words") or [])
        s["duration"] += max(0.0, float(seg["end"]) - float(seg["start"]))
        s["segments"] += 1
    return stats


def _identify_ghost_speakers(stats: Dict[str, dict]) -> set:
    if len(stats) <= 1:
        return set()
    max_words = max((s["words"] for s in stats.values()), default=0) or 1
    ghosts = set()
    for sp, s in stats.items():
        absolute_ghost = (
            s["words"] <= GHOST_MAX_WORDS and s["duration"] <= GHOST_MAX_DURATION
        )
        relative_ghost = (
            s["words"] < GHOST_RELATIVE_RATIO * max_words
            and s["duration"] <= GHOST_MAX_DURATION
        )
        if absolute_ghost or relative_ghost:
            ghosts.add(sp)
    # Safety: never flag EVERY speaker as a ghost — always keep the busiest one.
    if len(ghosts) >= len(stats):
        busiest = max(
            stats, key=lambda sp: (stats[sp]["words"], stats[sp]["duration"])
        )
        ghosts.discard(busiest)
    return ghosts


def _nearest_primary_label(segments: List[dict], idx: int, ghosts: set):
    """Speaker label of the temporally nearest non-ghost segment (prev wins ties)."""
    n = len(segments)
    for dist in range(1, n):
        before = idx - dist
        if before >= 0 and segments[before]["speaker"] not in ghosts:
            return segments[before]["speaker"]
        after = idx + dist
        if after < n and segments[after]["speaker"] not in ghosts:
            return segments[after]["speaker"]
    return None


def _merge_ghost_speakers(segments: List[dict]) -> List[dict]:
    """Reassign ghost-speaker segments to the nearest primary speaker, then
    coalesce consecutive same-speaker segments into single blocks.

    Word-level {word, start, end} entries are carried over VERBATIM (never
    recomputed or reordered), so frontend karaoke highlighting stays exact.
    """
    if len(segments) < 2:
        return segments

    ghosts = _identify_ghost_speakers(_speaker_stats(segments))
    if not ghosts:
        return segments

    # 1) Relabel each ghost segment to its nearest primary speaker.
    for i, seg in enumerate(segments):
        if seg["speaker"] in ghosts:
            target = _nearest_primary_label(segments, i, ghosts)
            if target is not None:
                seg["speaker"] = target

    # 2) Coalesce now-adjacent same-speaker segments into one speech block.
    merged: List[dict] = []
    for seg in segments:
        if merged and merged[-1]["speaker"] == seg["speaker"]:
            prev = merged[-1]
            prev["text"] = f'{prev["text"]} {seg["text"]}'.strip()
            prev["words"] = (prev.get("words") or []) + (seg.get("words") or [])
            prev["start"] = round(min(float(prev["start"]), float(seg["start"])), 3)
            prev["end"] = round(max(float(prev["end"]), float(seg["end"])), 3)
        else:
            merged.append(dict(seg))
    return merged


def _renumber_speakers(segments: List[dict]) -> List[dict]:
    """Remap speaker labels to contiguous 'Speaker 1..N' by first appearance."""
    remap: Dict[str, str] = {}
    for seg in segments:
        sp = seg["speaker"]
        if sp not in remap:
            remap[sp] = f"Speaker {len(remap) + 1}"
        seg["speaker"] = remap[sp]
    return segments


def _run_diarization(audio_bytes: bytes, filename: str, content_type: str = "") -> list:
    client = build_openai_client()
    deployment = os.getenv("AZURE_DIARIZE_DEPLOYMENT", "gpt-4o-transcribe-diarize").strip()

    safe_name = filename or "audio.ogg"
    mime = content_type or "audio/ogg"

    resp = _create_diarized_transcription(
        client, deployment, safe_name, audio_bytes, mime
    )
    data = (
        resp.model_dump()
        if hasattr(resp, "model_dump")
        else (resp if isinstance(resp, dict) else json.loads(str(resp)))
    )

    speaker_map: Dict[str, str] = {}
    segments: List[dict] = []
    for seg in data.get("segments") or []:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        # Noise filter: don't let short non-verbal fragments (breaths, clicks,
        # "(breath)", "*", "...", etc.) spawn a brand-new speaker. We skip the
        # segment entirely so it neither adds clutter nor inflates the count.
        if _is_noise_fragment(text):
            continue
        raw = str(seg.get("speaker", "") or "").strip() or "unknown"
        # No speaker cap — register as many distinct speakers as the model hears.
        if raw not in speaker_map:
            speaker_map[raw] = f"Speaker {len(speaker_map) + 1}"
        label = speaker_map[raw]
        start = float(seg.get("start", 0.0) or 0.0)
        end = float(seg.get("end", start) or start)
        # Preserve the diarizer's REAL per-word timestamps when present; only
        # fall back to proportional interpolation if the model didn't return
        # word-level timing. Either way the frontend receives {word,start,end}.
        raw_words = seg.get("words")
        if isinstance(raw_words, list) and raw_words:
            words = []
            for w in raw_words:
                token = str(w.get("word", w.get("text", "")) or "").strip()
                if not token:
                    continue
                w_start = float(w.get("start", start) or start)
                w_end = float(w.get("end", w_start) or w_start)
                words.append(
                    {
                        "word": token,
                        "start": round(w_start, 3),
                        "end": round(w_end, 3),
                    }
                )
            if not words:
                words = interpolate_words(text, start, end)
        else:
            words = interpolate_words(text, start, end)
        segments.append(
            {
                "type": "transcript",
                "text": f"{text}",
                "speaker": label,
                "start": round(start, 3),
                "end": round(end, 3),
                "words": words,
            }
        )

    # Dynamic cleanup: fold hallucinated "ghost" speakers (coughs, "Hmm",
    # transient crosstalk) into the nearest real speaker, then renumber the
    # surviving speakers 1..N. No fixed speaker cap — real participants are kept.
    segments = _merge_ghost_speakers(segments)
    segments = _renumber_speakers(segments)
    return segments


@app.post("/diarize/stream")
async def diarize_stream(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    try:
        segments = await asyncio.to_thread(
            _run_diarization,
            audio_bytes,
            file.filename or "audio.ogg",
            file.content_type or "audio/ogg",
        )
    except HTTPException:
        raise
    except Exception as exc:
        # Log the full technical detail server-side; return only a clean,
        # human-readable English sentence to the client (live + upload both).
        traceback.print_exc()
        return {"status": "error", "message": _friendly_diarize_error(exc)}

    # Cloud Vault is a stateless proxy for the OpenAI/Azure diarization call only.
    # Transcripts are NEVER persisted in Cosmos DB — the renderer saves them to the
    # user's local PC. Cosmos DB is reserved exclusively for login credentials.
    return {
        "status": "success",
        "segments": segments,
        "merged_transcript": segments,
    }


@app.get("/")
async def root():
    return {"status": "ok", "message": "ThreadNotes Cloud Vault is running."}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")), log_level="info")
