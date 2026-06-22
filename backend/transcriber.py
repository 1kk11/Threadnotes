import os
import io
import wave
import json
import time
import re
from openai import OpenAI, AzureOpenAI
from dotenv import load_dotenv

load_dotenv()
SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
CHANNELS = 1


def pcm_to_wav_bytes(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    buf.seek(0)
    return buf.read()


def interpolate_words(text: str, start: float, end: float) -> list:
    """Spread a phrase's [start, end] across its words proportionally to each
    word's character length. Approximate (synthetic) per-word timings."""
    words = text.split()
    if not words:
        return []
    weights = []
    for w in words:
        w_weight = len(w) + 1
        if w.endswith(('.', '?', '!', ',', ';', '-')):
            w_weight += 5
        weights.append(w_weight)

    total = sum(weights)
    duration = max(0.0, end - start)
    out = []
    cursor = start
    for w, weight in zip(words, weights):
        w_dur = duration * (weight / total)
        w_start = round(cursor, 3)
        cursor += w_dur
        w_end = round(min(end, cursor), 3)
        out.append({"word": w, "start": w_start, "end": w_end})

    if out:
        out[-1]["end"] = round(end, 3)

    return out


class Transcriber:
    def __init__(self):
        api_key = (
            os.getenv("AZURE_OPENAI_KEY") or os.getenv("OPENAI_API_KEY") or ""
        ).strip()
        azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
        api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2025-04-01-preview").strip()

        if azure_endpoint:
            self.client = AzureOpenAI(
                api_key=api_key,
                api_version=api_version,
                azure_endpoint=azure_endpoint,
                timeout=180,
            )
        else:
            self.client = OpenAI(api_key=api_key, timeout=180)

        self.diarize_deployment = os.getenv(
            "AZURE_DIARIZE_DEPLOYMENT", "gpt-4o-transcribe-diarize"
        ).strip()

        self.file_deployment = (
            os.getenv("AZURE_FILE_DEPLOYMENT", "").strip() or self.diarize_deployment
        )

    def diarize_full(self, pcm_bytes: bytes) -> list:
        if not pcm_bytes:
            return []

        try:
            wav = pcm_to_wav_bytes(pcm_bytes)
            resp = self.client.audio.transcriptions.create(
                model=self.diarize_deployment,
                file=("conversation.wav", wav, "audio/wav"),
                response_format="diarized_json",
                extra_body={"chunking_strategy": "auto"},
            )
        except Exception:
            return []

        if hasattr(resp, "model_dump"):
            data = resp.model_dump()
        elif isinstance(resp, dict):
            data = resp
        else:
            data = json.loads(str(resp))

        segments = data.get("segments") or []

        speaker_map: dict = {}
        results = []
        for seg in segments:
            text = (seg.get("text") or "").strip()
            if not text:
                continue

            raw_speaker = str(seg.get("speaker", "") or "").strip() or "unknown"
            if raw_speaker not in speaker_map:
                speaker_map[raw_speaker] = f"Speaker {len(speaker_map) + 1}"
            label = speaker_map[raw_speaker]

            start = float(seg.get("start", 0.0) or 0.0)
            end = float(seg.get("end", start) or start)

            results.append(
                {
                    "type": "transcript",
                    "text": f"[{label}] {text}",
                    "speaker": label,
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "words": interpolate_words(text, start, end),
                }
            )
        return results

    def _parse_retry_after(self, error_msg: str) -> int:
        if not error_msg:
            return 0
        match = re.search(
            r"Please try again in\s*((\d+)m)?\s*([0-9]+(?:\.[0-9]+)?)s", error_msg
        )
        if not match:
            return 0
        minutes = int(match.group(2)) if match.group(2) else 0
        seconds = float(match.group(3))
        return int(minutes * 60 + seconds) + 1

    def transcribe_audio_file(self, file_path: str) -> str:
        for attempt in range(1, 4):
            try:
                with open(file_path, "rb") as audio_file:
                    response = self.client.audio.transcriptions.create(
                        model=self.file_deployment,
                        file=audio_file,
                        response_format="text",
                        extra_body={"chunking_strategy": "auto"},
                    )
                text = response if isinstance(response, str) else getattr(
                    response, "text", ""
                )
                if text and text.strip():
                    return text.strip()
                raise Exception("Empty response received from API")

            except Exception as e:
                error_msg = str(e)
                if "rate limit" in error_msg.lower() or "429" in error_msg:
                    wait_time = max(self._parse_retry_after(error_msg), 5)
                else:
                    wait_time = min(2 ** attempt, 10)
                if attempt < 3:
                    time.sleep(wait_time)
                    continue
                return ""
        return ""
