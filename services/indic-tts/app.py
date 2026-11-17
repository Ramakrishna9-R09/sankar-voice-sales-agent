"""Sentence-level open-weight IndicF5 adapter used by the Node speech route."""
import asyncio
import io
import os
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from transformers import AutoModel

MODEL_ID = os.getenv("INDIC_TTS_MODEL", "ai4bharat/IndicF5")
REFERENCE_AUDIO = os.getenv("INDIC_TTS_REFERENCE_AUDIO", "")
REFERENCE_TEXT = os.getenv("INDIC_TTS_REFERENCE_TEXT", "")
MODEL = None
TTS_SLOTS = asyncio.Semaphore(max(1, int(os.getenv("TTS_CONCURRENCY", "1"))))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global MODEL
    MODEL = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
    yield
    MODEL = None


app = FastAPI(title="Sankar Indic TTS", lifespan=lifespan)


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=320)
    language: str = Field(default="English", max_length=30)


@app.get("/health")
def health():
    return {"ok": MODEL is not None, "model": MODEL_ID, "reference_configured": bool(REFERENCE_AUDIO and REFERENCE_TEXT)}


def render(text: str, language: str) -> bytes:
    if not REFERENCE_AUDIO or not REFERENCE_TEXT:
        raise RuntimeError("Configure a licensed, consented reference voice clip and its exact transcript.")
    # The selected language controls transcript/script upstream; injecting instructions here
    # would cause a TTS model to read those instructions aloud as if they were customer text.
    waveform = MODEL(text, ref_audio_path=REFERENCE_AUDIO, ref_text=REFERENCE_TEXT)
    audio = np.asarray(waveform, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.squeeze()
    buffer = io.BytesIO()
    sf.write(buffer, audio, samplerate=24000, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@app.post("/synthesize")
async def synthesize(payload: SpeechRequest):
    if MODEL is None:
        raise HTTPException(status_code=503, detail="TTS model is not ready")
    try:
        # IndicF5 is a GPU model. Bound inference concurrency so bursts queue instead of
        # exhausting VRAM and taking every active call down.
        async with TTS_SLOTS:
            audio = await run_in_threadpool(render, payload.text.strip(), payload.language)
        return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Speech synthesis is temporarily unavailable") from exc
