"""Authenticated WebSocket bridge for open streaming ASR models.

Deploy behind TLS. The Node control plane issues 120-second HMAC JWTs so the
model worker never receives Groq/provider credentials or full CRM data.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("sankar.voice_gateway")
ENGINE = os.getenv("ASR_ENGINE", "qwen3").lower()
MODEL_ID = os.getenv("ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
JWT_SECRET = os.getenv("VOICE_GATEWAY_SECRET", "")
MAX_SECONDS = int(os.getenv("MAX_CALL_SECONDS", "1800"))
MAX_AUDIO_BYTES = 16_000 * 2 * MAX_SECONDS
MAX_CONCURRENT_INFERENCE = max(1, int(os.getenv("ASR_CONCURRENCY", "4")))
MODEL = None
INFERENCE_SLOTS = asyncio.Semaphore(MAX_CONCURRENT_INFERENCE)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global MODEL
    if len(JWT_SECRET) < 32:
        raise RuntimeError("VOICE_GATEWAY_SECRET must contain at least 32 characters")
    if ENGINE == "qwen3":
        from qwen_asr import Qwen3ASRModel
        MODEL = Qwen3ASRModel.LLM(
            model=MODEL_ID,
            gpu_memory_utilization=float(os.getenv("ASR_GPU_MEMORY_UTILIZATION", "0.25")),
            max_new_tokens=64,
        )
    elif ENGINE == "whisper":
        from faster_whisper import WhisperModel
        MODEL = WhisperModel(
            MODEL_ID,
            device=os.getenv("ASR_DEVICE", "cuda"),
            compute_type=os.getenv("ASR_COMPUTE_TYPE", "float16"),
            cpu_threads=max(1, int(os.getenv("ASR_CPU_THREADS", "4"))),
        )
    else:
        raise RuntimeError("ASR_ENGINE must be qwen3 or whisper")
    log.info("asr_worker_ready engine=%s model=%s", ENGINE, MODEL_ID)
    yield
    MODEL = None


app = FastAPI(title="Sankar Open Voice Gateway", lifespan=lifespan)


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def validate_session(token: str) -> dict | None:
    try:
        header, payload, signature = token.split(".")
        signed = f"{header}.{payload}".encode()
        expected = hmac.new(JWT_SECRET.encode(), signed, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, b64url_decode(signature)):
            return False
        claims = json.loads(b64url_decode(payload))
        if claims.get("aud") == "sankar-voice-gateway" and int(claims.get("exp", 0)) >= int(time.time()) and claims.get("call_id"):
            return claims
        return None
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def whisper_transcribe(samples: np.ndarray, language: str | None) -> tuple[str, float | None]:
    segments, _info = MODEL.transcribe(samples, language=language, beam_size=1, vad_filter=False, condition_on_previous_text=False)
    parts = []
    log_probs = []
    for segment in segments:
        value = segment.text.strip()
        if value:
            parts.append(value)
            if getattr(segment, "avg_logprob", None) is not None:
                log_probs.append(float(segment.avg_logprob))
    # Whisper log probability is diagnostic, not a calibrated confidence score.
    return " ".join(parts).strip(), (sum(log_probs) / len(log_probs) if log_probs else None)


@app.get("/health")
def health():
    return {"ok": MODEL is not None, "engine": ENGINE, "model": MODEL_ID}


@app.websocket("/ws/transcribe")
async def transcribe(websocket: WebSocket):
    token = websocket.query_params.get("token", "")
    claims = validate_session(token)
    if not claims:
        await websocket.close(code=4401, reason="invalid or expired session")
        return
    await websocket.accept()
    call_id = str(claims["call_id"])
    session_started = time.monotonic()
    started = time.monotonic()
    audio_bytes = 0
    session_bytes = 0
    language = "English"
    samples: list[np.ndarray] = []
    qwen_state = None
    last_partial_samples = 0
    partial_text = ""
    language_codes = {"english": "en", "hindi": "hi", "tamil": "ta", "telugu": "te", "tanglish": "ta"}
    try:
        while True:
            if time.monotonic() - session_started > MAX_SECONDS:
                await websocket.send_json({"type": "error", "message": "Call reached the configured ASR duration limit."})
                await websocket.close(code=1008, reason="duration limit")
                return
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=90)
            except asyncio.TimeoutError:
                await websocket.close(code=1001, reason="idle timeout")
                return
            if message.get("type") == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                raw = message["bytes"]
                audio_bytes += len(raw)
                session_bytes += len(raw)
                if session_bytes > MAX_AUDIO_BYTES:
                    await websocket.send_json({"type": "error", "message": "Audio exceeded the configured call limit."})
                    await websocket.close(code=1009, reason="audio limit")
                    return
                if len(raw) % 2:
                    continue
                pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
                if ENGINE == "qwen3":
                    if qwen_state is None:
                        qwen_state = MODEL.init_streaming_state(unfixed_chunk_num=2, unfixed_token_num=5, chunk_size_sec=1.0)
                    async with INFERENCE_SLOTS:
                        await run_in_threadpool(MODEL.streaming_transcribe, pcm, qwen_state)
                    current = str(getattr(qwen_state, "text", "") or "").strip()
                    if current and current != partial_text:
                        partial_text = current
                        await websocket.send_json({"type": "partial", "text": current, "engine": ENGINE})
                else:
                    samples.append(pcm)
                    count = sum(part.size for part in samples)
                    # Whisper is chunk-streamed rather than token-streamed: emit revisable partials
                    # every 1.5s of voiced audio, then run once more for the final utterance.
                    if count - last_partial_samples >= 24_000:
                        waveform = np.concatenate(samples)
                        async with INFERENCE_SLOTS:
                            current, logprob = await run_in_threadpool(whisper_transcribe, waveform, language_codes.get(language.lower()))
                        if current and current != partial_text:
                            partial_text = current
                            await websocket.send_json({"type": "partial", "text": current, "mean_log_probability": logprob, "engine": ENGINE})
                        last_partial_samples = count
                continue

            try:
                control = json.loads(message.get("text") or "{}")
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid voice control message."})
                continue
            if control.get("type") == "start":
                language = str(control.get("language") or "English")[:30]
                # The model path is fixed per worker. Deploy a Qwen worker for English/Hindi;
                # point Tamil/Telugu to a faster-whisper worker selected by the Node router.
                if ENGINE == "qwen3" and language.lower() in {"tamil", "telugu"}:
                    await websocket.send_json({"type": "error", "message": f"Qwen3-ASR worker is not configured for {language}. Route this language to the Whisper worker."})
                    await websocket.close(code=1008, reason="unsupported language on this worker")
                    return
                await websocket.send_json({"type": "ready", "engine": ENGINE, "language": language})
            elif control.get("type") == "end":
                if ENGINE == "qwen3" and qwen_state is not None:
                    async with INFERENCE_SLOTS:
                        await run_in_threadpool(MODEL.finish_streaming_transcribe, qwen_state)
                    final_text = str(getattr(qwen_state, "text", "") or "").strip()
                    await websocket.send_json({"type": "final", "text": final_text, "engine": ENGINE})
                elif samples:
                    waveform = np.concatenate(samples)
                    async with INFERENCE_SLOTS:
                        final_text, logprob = await run_in_threadpool(whisper_transcribe, waveform, language_codes.get(language.lower()))
                    await websocket.send_json({"type": "final", "text": final_text, "mean_log_probability": logprob, "engine": ENGINE})
                else:
                    await websocket.send_json({"type": "final", "text": "", "engine": ENGINE})
                samples = []
                audio_bytes = 0
                qwen_state = None
                last_partial_samples = 0
                partial_text = ""
                started = time.monotonic()
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # fail a session cleanly; never send model internals to the browser.
        log.exception("asr_session_error call_id=%s", call_id)
        try:
            await websocket.send_json({"type": "error", "message": "Speech recognition is temporarily unavailable."})
            await websocket.close(code=1011)
        except Exception:
            pass
