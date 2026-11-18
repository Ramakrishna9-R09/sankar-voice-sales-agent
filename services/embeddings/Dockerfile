FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY app.py .
ENV EMBEDDING_MODEL=intfloat/multilingual-e5-small
EXPOSE 8012
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8012", "--no-access-log"]
