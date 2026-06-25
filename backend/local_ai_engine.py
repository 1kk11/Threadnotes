from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pyannote.audio import Pipeline
import uvicorn


class AzureTranscriptItem(BaseModel):
    text: str = Field(..., description="Transcript text for this chunk")
    start: Optional[float] = Field(
        None,
        description="Start time in seconds",
    )
    end: Optional[float] = Field(
        None,
        description="End time in seconds",
    )
    offset: Optional[float] = Field(
        None,
        description="Alternative start time in seconds",
    )
    duration: Optional[float] = Field(
        None,
        description="Alternative duration in seconds",
    )


class DiarizeAndMergeRequest(BaseModel):
    audio_file_path: str = Field(..., description="Absolute path to the local audio file")
    azure_transcript: List[AzureTranscriptItem] = Field(
        ..., description="Live Azure transcript chunks with timestamps",
    )


class SpeakerSegment(BaseModel):
    speaker: str
    start: float
    end: float


class SpeakerLabeledTranscriptItem(BaseModel):
    speaker: str
    text: str
    start: float
    end: float


app = FastAPI(
    title="ThreadNotes Local AI Engine",
    description="Local speaker diarization and merge service for ThreadNotes.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

HF_TOKEN = os.getenv("HUGGINGFACE_TOKEN") or os.getenv("HF_TOKEN")
PYANNOTE_PIPELINE = os.getenv(
    "PYANNOTE_PIPELINE", "pyannote/speaker-diarization",
)

_pipeline: Optional[Pipeline] = None


def get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        if not HF_TOKEN:
            raise RuntimeError(
                "Missing Hugging Face token. Set HUGGINGFACE_TOKEN or HF_TOKEN."
            )

        _pipeline = Pipeline.from_pretrained(
            PYANNOTE_PIPELINE,
            use_auth_token=HF_TOKEN,
        )
    return _pipeline


def normalize_timestamps(item: AzureTranscriptItem) -> Dict[str, float]:
    if item.start is not None and item.end is not None:
        return {"start": float(item.start), "end": float(item.end)}

    if item.offset is not None and item.duration is not None:
        return {
            "start": float(item.offset),
            "end": float(item.offset + item.duration),
        }

    raise ValueError(
        "Azure transcript item must include start/end or offset + duration.",
    )


def load_diarization_segments(audio_file_path: str) -> List[SpeakerSegment]:
    file_path = Path(audio_file_path)
    if not file_path.exists():
        raise HTTPException(
            status_code=400,
            detail=f"Audio file does not exist: {audio_file_path}",
        )

    pipeline = get_pipeline()
    diarization = pipeline({"uri": file_path.stem, "audio": str(file_path)})

    segments: List[SpeakerSegment] = []
    for segment, track, label in diarization.itertracks(yield_label=True):
        segments.append(
            SpeakerSegment(
                speaker=label,
                start=round(float(segment.start), 3),
                end=round(float(segment.end), 3),
            )
        )

    if not segments:
        raise HTTPException(
            status_code=500,
            detail="Diarization returned no speaker segments.",
        )

    return segments


def assign_speaker(
    start: float,
    end: float,
    speaker_segments: List[SpeakerSegment],
) -> str:
    best_label = "Unknown"
    best_overlap = 0.0

    for segment in speaker_segments:
        overlap = min(end, segment.end) - max(start, segment.start)
        if overlap > best_overlap:
            best_overlap = overlap
            best_label = segment.speaker

    if best_overlap > 0:
        return best_label

    # No overlap found: choose nearest speaker boundary.
    closest_segment = min(
        speaker_segments,
        key=lambda segment: min(abs(start - segment.start), abs(end - segment.end)),
    )
    return closest_segment.speaker


def relabel_speakers(speaker_segments: List[SpeakerSegment]) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    speaker_order: List[str] = []

    for segment in speaker_segments:
        if segment.speaker not in mapping:
            speaker_order.append(segment.speaker)
            mapping[segment.speaker] = f"Speaker {len(speaker_order)}"

    return mapping


def merge_azure_with_speakers(
    azure_transcript: List[AzureTranscriptItem],
    speaker_segments: List[SpeakerSegment],
) -> List[SpeakerLabeledTranscriptItem]:
    speaker_map = relabel_speakers(speaker_segments)
    merged: List[SpeakerLabeledTranscriptItem] = []

    for item in azure_transcript:
        timestamps = normalize_timestamps(item)
        speaker = assign_speaker(
            timestamps["start"], timestamps["end"], speaker_segments,
        )
        merged.append(
            SpeakerLabeledTranscriptItem(
                speaker=speaker_map.get(speaker, "Speaker 1"),
                text=item.text,
                start=timestamps["start"],
                end=timestamps["end"],
            )
        )

    return merged


@app.post("/diarize-and-merge")
async def diarize_and_merge(request: DiarizeAndMergeRequest) -> Dict[str, Any]:
    speaker_segments = load_diarization_segments(request.audio_file_path)
    merged_transcript = merge_azure_with_speakers(
        request.azure_transcript,
        speaker_segments,
    )

    return {
        "status": "success",
        "audio_file_path": request.audio_file_path,
        "diarization": [segment.dict() for segment in speaker_segments],
        "merged_transcript": [item.dict() for item in merged_transcript],
    }


if __name__ == "__main__":
    uvicorn.run(
        "local_ai_engine:app",
        host="127.0.0.1",
        port=8000,
        log_level="info",
        access_log=False,
    )
