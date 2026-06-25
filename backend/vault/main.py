from datetime import datetime, timezone, timedelta
import asyncio
import json
import os
import random
import smtplib
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
from azure.cosmos import CosmosClient, PartitionKey
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

security = HTTPBearer(auto_error=True)

otp_storage: Dict[str, str] = {}
signup_otp_storage: Dict[str, str] = {}

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


TRANSCRIPTS_CONTAINER = os.getenv("COSMOS_TRANSCRIPTS_CONTAINER", "transcripts")
_transcripts_cont = None


def get_transcripts_container():
    global _transcripts_cont
    if _transcripts_cont is None:
        if not COSMOS_ENDPOINT or not COSMOS_KEY or not DATABASE_NAME:
            raise HTTPException(status_code=500, detail="Cosmos DB configuration is missing.")
        client = CosmosClient(COSMOS_ENDPOINT, COSMOS_KEY)
        database = client.get_database_client(DATABASE_NAME)
        _transcripts_cont = database.create_container_if_not_exists(
            id=TRANSCRIPTS_CONTAINER,
            partition_key=PartitionKey(path="/userId"),
        )
    return _transcripts_cont


def build_openai_client():
    from openai import OpenAI, AzureOpenAI

    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
    key = (os.getenv("AZURE_OPENAI_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
    if not key:
        raise HTTPException(status_code=500, detail="OpenAI/Azure OpenAI key is missing in the vault.")
    if endpoint:
        return AzureOpenAI(
            api_key=key,
            api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2025-04-01-preview").strip(),
            azure_endpoint=endpoint,
            timeout=300,
        )
    return OpenAI(api_key=key, timeout=300)


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


def send_otp_email(target_email: str, otp: str, subject_prefix: str):
    sender_email = os.getenv("EMAIL_SENDER")
    sender_password = os.getenv("EMAIL_PASSWORD")
    if not sender_email or not sender_password:
        raise HTTPException(status_code=500, detail="Email configuration missing in backend")

    msg = MIMEMultipart()
    msg["From"] = sender_email
    msg["To"] = target_email
    msg["Subject"] = f"ThreadNotes - {subject_prefix} OTP"
    body = f"Your OTP for {subject_prefix} is: {otp}\n\nPlease do not share this with anyone."
    msg.attach(MIMEText(body, "plain"))

    try:
        server = smtplib.SMTP("smtp.gmail.com", 587)
        server.starttls()
        server.login(sender_email, sender_password)
        server.send_message(msg)
        server.quit()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to send email: {exc}")


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

    otp = str(random.randint(100000, 999999))
    signup_otp_storage[req.email] = otp
    send_otp_email(req.email, otp, "Signup Verification")
    return {"status": "success", "message": "Verification OTP sent successfully."}


@app.post("/verify-signup-otp")
def verify_signup_otp(req: OTPVerifyRequest):
    if signup_otp_storage.get(req.email) != req.otp:
        raise HTTPException(status_code=400, detail="Invalid or expired verification OTP")
    return {"status": "success", "message": "Email verified successfully."}


@app.post("/signup")
def signup(user: UserSignup):
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
    if not user_list:
        return {"status": "success", "message": "If email exists, OTP sent."}

    otp = str(random.randint(100000, 999999))
    otp_storage[req.email] = otp
    send_otp_email(req.email, otp, "Password Reset")
    return {"status": "success", "message": "OTP sent successfully."}


@app.post("/reset-password")
def reset_password(req: ResetPasswordRequest):
    if otp_storage.get(req.email) != req.otp:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP")

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
    otp_storage.pop(req.email, None)
    return {"status": "success", "message": "Password updated successfully!"}


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


def _run_diarization(audio_bytes: bytes, filename: str, content_type: str = "") -> list:
    client = build_openai_client()
    deployment = os.getenv("AZURE_DIARIZE_DEPLOYMENT", "gpt-4o-transcribe-diarize").strip()

    safe_name = filename or "audio.ogg"
    mime = content_type or "audio/ogg"

    resp = client.audio.transcriptions.create(
        model=deployment,
        file=(safe_name, audio_bytes, mime),
        response_format="diarized_json",
        extra_body={"chunking_strategy": "auto"},
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
        raw = str(seg.get("speaker", "") or "").strip() or "unknown"
        if raw not in speaker_map:
            speaker_map[raw] = f"Speaker {len(speaker_map) + 1}"
        label = speaker_map[raw]
        start = float(seg.get("start", 0.0) or 0.0)
        end = float(seg.get("end", start) or start)
        segments.append(
            {
                "type": "transcript",
                "text": f"[{label}] {text}",
                "speaker": label,
                "start": round(start, 3),
                "end": round(end, 3),
                "words": interpolate_words(text, start, end),
            }
        )
    return segments


def _save_transcript(user_id: str, segments: list) -> str:
    try:
        container = get_transcripts_container()
        doc_id = str(uuid.uuid4())
        container.upsert_item(
            {
                "id": doc_id,
                "userId": user_id,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "segments": segments,
            }
        )
        return doc_id
    except Exception:
        return ""


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
        return {"status": "error", "message": str(exc)}

    doc_id = _save_transcript(user.get("sub", "unknown"), segments)
    return {
        "status": "success",
        "id": doc_id,
        "segments": segments,
        "merged_transcript": segments,
    }


@app.get("/")
async def root():
    return {"status": "ok", "message": "ThreadNotes Cloud Vault is running."}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")), log_level="info")
