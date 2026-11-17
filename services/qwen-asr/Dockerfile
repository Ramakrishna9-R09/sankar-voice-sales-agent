FROM vllm/vllm-openai:v0.14.0
WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY voice_gateway.py .
ENV ASR_ENGINE=qwen3 ASR_MODEL=Qwen/Qwen3-ASR-0.6B
EXPOSE 8100
CMD ["uvicorn", "voice_gateway:app", "--host", "0.0.0.0", "--port", "8100", "--no-access-log"]
