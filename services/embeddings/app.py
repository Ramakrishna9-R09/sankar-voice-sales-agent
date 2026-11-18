"""Small CPU embedding worker for optional lexical+dense product retrieval."""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator
from starlette.concurrency import run_in_threadpool

MODEL_NAME = os.getenv(
    "EMBEDDING_MODEL",
    "intfloat/multilingual-e5-small",
)
MODEL = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global MODEL
    from fastembed import TextEmbedding

    MODEL = TextEmbedding(model_name=MODEL_NAME)
    yield
    MODEL = None


app = FastAPI(title="Sankar Local Knowledge Embeddings", lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=400)

    @validator("texts")
    def validate_texts(cls, values):
        if any(not isinstance(text, str) or not text.strip() or len(text) > 900 for text in values):
            raise ValueError("Each text must contain 1 to 900 characters.")
        return values


@app.get("/health")
def health():
    return {"ok": MODEL is not None, "model": MODEL_NAME, "device": "cpu"}


@app.post("/embed")
async def embed(payload: EmbedRequest):
    if MODEL is None:
        raise HTTPException(status_code=503, detail="Embedding model is not ready")
    try:
        vectors = await run_in_threadpool(lambda: list(MODEL.embed(payload.texts, batch_size=32)))
        return {
            "model": MODEL_NAME,
            "embeddings": [vector.astype("float32").tolist() for vector in vectors],
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Embedding inference is temporarily unavailable") from exc
