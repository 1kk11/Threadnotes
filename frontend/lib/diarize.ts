const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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

  const { chunks, mimeType } =
    await electron.audioCompressAndRead(audioFilePath);

  opts.onProgress?.(0, chunks.length);

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
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
    if (result.text) parts.push(String(result.text).trim());
    opts.onProgress?.(i + 1, chunks.length);
  }

  return parts.filter(Boolean).join("\n\n");
}
