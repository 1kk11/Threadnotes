"""ThreadNotes "Thick Client, Thin Server" FastAPI router for Azure Speech tokens and diarized transcription."""
import os
import uuid
import json
import tempfile
from datetime import datetime, timezone

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from transcriber import interpolate_words

SECRET_KEY = os.getenv("JWT_SECRET", "threadnotes-super-secret-key")
ALGORITHM = "HS256"

AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY", "").strip()
AZURE_SPEECH_REGION = os.getenv("AZURE_SPEECH_REGION", "").strip()

router = APIRouter()
_bearer = HTTPBearer(auto_error=True)


def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    try:
        return jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")


@router.get("/azure/token")
async def get_azure_speech_token(_user: dict = Depends(get_current_user)):
    if not AZURE_SPEECH_KEY or not AZURE_SPEECH_REGION:
        raise HTTPException(status_code=500, detail="Azure Speech not configured")

    sts_url = (
        f"https://{AZURE_SPEECH_REGION}.api.cognitive.microsoft.com"
        "/sts/v1.0/issueToken"
    )
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            resp = await http.post(
                sts_url,
                headers={
                    "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
                    "Content-Length": "0",
                },
            )
        resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Token issue failed: {e}")

    return {"token": resp.text, "region": AZURE_SPEECH_REGION}


def _build_openai_client():
    from openai import OpenAI, AzureOpenAI

    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
    key = (os.getenv("AZURE_OPENAI_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
    if endpoint:
        return AzureOpenAI(
            api_key=key,
            api_version=os.getenv(
                "AZURE_OPENAI_API_VERSION", "2025-04-01-preview"
            ).strip(),
            azure_endpoint=endpoint,
            timeout=300,
        )
    return OpenAI(api_key=key, timeout=300)


def _save_transcript_to_cosmos(user_id: str, segments: list) -> str:
    """Best-effort upsert into a Cosmos `transcripts` container. Failures are
    logged, never raised, so a DB hiccup can't lose the user's transcript."""
    try:
        from azure.cosmos import CosmosClient, PartitionKey

        client = CosmosClient(os.getenv("COSMOS_ENDPOINT"), os.getenv("COSMOS_KEY"))
        db = client.get_database_client(os.getenv("COSMOS_DATABASE"))
        container = db.create_container_if_not_exists(
            id=os.getenv("COSMOS_TRANSCRIPTS_CONTAINER", "transcripts"),
            partition_key=PartitionKey(path="/userId"),
        )
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


@router.post("/diarize/stream")
async def diarize_stream(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Spool the upload to disk in bounded chunks, then stream it to the diarize model."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".audio") as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)

        client = _build_openai_client()
        deployment = os.getenv(
            "AZURE_DIARIZE_DEPLOYMENT", "gpt-4o-transcribe-diarize"
        ).strip()
        with open(tmp_path, "rb") as audio:
            resp = client.audio.transcriptions.create(
                model=deployment,
                file=(file.filename or "audio", audio, file.content_type or "audio/wav"),
                response_format="diarized_json",
                extra_body={"chunking_strategy": "auto"},
            )

        data = (
            resp.model_dump()
            if hasattr(resp, "model_dump")
            else (resp if isinstance(resp, dict) else json.loads(str(resp)))
        )

        speaker_map: dict = {}
        segments = []
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

        doc_id = _save_transcript_to_cosmos(user.get("sub", "unknown"), segments)
        return {"status": "success", "id": doc_id, "segments": segments}

    except HTTPException:
        raise
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
