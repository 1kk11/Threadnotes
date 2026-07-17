# ThreadNotes backend — FastAPI + ffmpeg, containerized for Render.
FROM python:3.11-slim

# System dependency: ffmpeg powers the /transcribe audio chunking pipeline.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so this layer is cached across code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend source (.dockerignore excludes venv/.env/etc.).
COPY . .

# Render injects $PORT at runtime; default to 8000 for local `docker run`.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn vault.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
