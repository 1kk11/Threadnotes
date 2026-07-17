const API_URL = process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== "http://localhost:8000" ? process.env.NEXT_PUBLIC_API_URL : "https://threadnotes-backend-ih96.onrender.com";

export type DiarizeWord = { word: string; start: number; end: number };
export type DiarizeRow = {
  speaker: string;
  text: string;
  start: number;
  end: number;
  words?: DiarizeWord[];
};

type Opts = {
  jwt?: string | null;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

export async function diarizeAudioFile(
  audioFilePath: string,
  opts: Opts = {},
): Promise<DiarizeRow[]> {
  const electron =
    typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!electron?.audioCompressAndRead) {
    throw new Error("Audio processing is only available in the desktop app.");
  }

  const { chunks, segmentSeconds, mimeType } =
    await electron.audioCompressAndRead(audioFilePath);

  opts.onProgress?.(0, chunks.length);

  const stitched: DiarizeRow[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const { buffer, name } = chunks[i];
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), name);

    const res = await fetch(`${API_URL}/diarize/stream`, {
      method: "POST",
      headers: opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : undefined,
      body: form,
      signal: opts.signal,
    });
    const result = await res.json();
    if (!res.ok || result.status === "error") {
      throw new Error(
        result.detail ||
          result.message ||
          `Diarization failed on part ${i + 1}: ${res.status}`,
      );
    }

    const offset = i * segmentSeconds;
    const segs = Array.isArray(result.merged_transcript)
      ? result.merged_transcript
      : Array.isArray(result.segments)
        ? result.segments
        : [];
    for (const s of segs) {
      stitched.push({
        ...s,
        start: (Number(s.start) || 0) + offset,
        end: (Number(s.end) || 0) + offset,
        words: Array.isArray(s.words)
          ? s.words.map((w: DiarizeWord) => ({
              ...w,
              start: (Number(w.start) || 0) + offset,
              end: (Number(w.end) || 0) + offset,
            }))
          : s.words,
      });
    }

    opts.onProgress?.(i + 1, chunks.length);
  }

  return stitched;
}

export async function transcribeAudioFile(
  audioFilePath: string,
  opts: Opts = {},
): Promise<string> {
  const electron =
    typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!electron?.audioCompressAndRead) {
    throw new Error("Audio processing is only available in the desktop app.");
  }

  // gpt-4o-transcribe has a small audio-token limit, so transcription uses much
  // shorter chunks (5 min) than diarization (which keeps the large default).
  const { chunks, mimeType } = await electron.audioCompressAndRead(
    audioFilePath,
    300,
  );

  const total = chunks.length;
  const parts: string[] = new Array(total).fill("");
  let done = 0;
  opts.onProgress?.(0, total);

  // Transcription chunks are independent (just text, no cross-chunk speaker
  // identity), so we run them in parallel with a small worker pool for speed.
  // Results are stored by index to preserve order when stitched.
  const CONCURRENCY = Math.min(4, total || 1);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= total) break;
      const { buffer, name } = chunks[i];
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: mimeType }), name);

      const res = await fetch(`${API_URL}/transcribe/stream`, {
        method: "POST",
        headers: opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : undefined,
        body: form,
        signal: opts.signal,
      });
      const result = await res.json();
      if (!res.ok || result.status === "error") {
        throw new Error(
          result.detail ||
            result.message ||
            `Transcription failed on part ${i + 1}: ${res.status}`,
        );
      }
      parts[i] = result.text ? String(result.text).trim() : "";
      done += 1;
      opts.onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return parts.filter(Boolean).join("\n\n");
}

export async function diarizeAudioFileBackground(
  audioFilePath: string,
  opts: Opts = {},
): Promise<string> {
  const electron =
    typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!electron?.audioCompressAndRead) {
    throw new Error("Audio processing is only available in the desktop app.");
  }

  // Use a single chunk for background to avoid complicated stitching logic on backend for now.
  // In a production app, the backend should stitch chunks or the frontend should stitch results.
  const { chunks, mimeType } =
    await electron.audioCompressAndRead(audioFilePath, 3600); // chunk to 1 hour max

  if (chunks.length === 0) throw new Error("Empty audio file");

  const { buffer, name } = chunks[0];
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), name);

  const res = await fetch(`${API_URL}/diarize/background`, {
    method: "POST",
    headers: opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : undefined,
    body: form,
    signal: opts.signal,
  });
  
  const result = await res.json();
  if (!res.ok || result.status === "error") {
    throw new Error(result.message || "Failed to start background diarization");
  }
  
  return result.job_id;
}

export async function getDiarizeJobStatus(
  jobId: string,
  jwt?: string | null
): Promise<{ status: string; segments?: DiarizeRow[]; error?: string }> {
  const res = await fetch(`${API_URL}/jobs/${jobId}`, {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.detail || "Failed to get job status");
  
  return {
    status: result.job_status,
    segments: result.merged_transcript || result.segments,
    error: result.error,
  };
}
