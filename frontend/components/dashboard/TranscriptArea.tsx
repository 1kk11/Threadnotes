"use client";
import { useState, useRef, useEffect } from "react";
import { Upload, Pencil, Check } from "lucide-react";

export type Word = { word: string; start: number; end: number };
export type Segment = {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
  words?: Word[];
};

type TranscriptAreaProps = {
  transcriptText: string;
  segments?: Segment[];
  audioUrl?: string | null;
  showPlayback?: boolean;
  editable?: boolean; // hide Edit while a recording is live
  onSave?: () => void;
  onTranscriptEdit?: (text: string) => void;
};

const stripSpeakerPrefix = (text: string) => text.replace(/^\[.*?\]\s*/, "");

// Distinct, consistent name color per speaker (assigned in first-seen order).
const SPEAKER_PALETTE = [
  "text-indigo-600",
  "text-orange-500",
  "text-emerald-600",
  "text-rose-500",
  "text-violet-600",
  "text-amber-600",
];

export default function TranscriptArea({
  transcriptText,
  segments = [],
  audioUrl = null,
  showPlayback = false,
  editable = true,
  onSave,
  onTranscriptEdit,
}: TranscriptAreaProps) {
  const [playbackTime, setPlaybackTime] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");

  // Auto-scroll: keep the newest transcript in view as it grows.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editMode) return; // don't yank the view while the user is editing
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcriptText, segments, editMode]);

  const hasContent = transcriptText.trim().length > 0 || segments.length > 0;
  const inPlayback = showPlayback && segments.length > 0 && !editMode;

  // The flat text used both for the plain view and as the edit buffer source.
  const fullText =
    segments.length > 0
      ? segments
          .map((s) => `${s.speaker}: ${stripSpeakerPrefix(s.text)}`)
          .join("\n\n")
      : transcriptText;

  // Map each unique speaker to a consistent color (first-seen order).
  const speakerColors: Record<string, string> = {};
  segments.forEach((s) => {
    if (!(s.speaker in speakerColors)) {
      speakerColors[s.speaker] =
        SPEAKER_PALETTE[Object.keys(speakerColors).length % SPEAKER_PALETTE.length];
    }
  });

  const isWordActive = (w: Word) =>
    playbackTime >= w.start && playbackTime < w.end;

  const toggleEdit = () => {
    if (editMode) {
      setEditMode(false);
    } else {
      setDraft(fullText);
      setEditMode(true);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/60 bg-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.06)] backdrop-blur-xl">
      {/* Header row — logo gradient, white text (top corners stay rounded via
          the card's overflow-hidden rounded-2xl). */}
      <div className="flex items-center justify-between bg-linear-to-r from-violet-500 to-blue-500 px-6 py-4">
        <h3 className="text-base font-bold text-white">
          {inPlayback ? "Playback & Transcript" : "Conversation Transcript"}
        </h3>
        <div className="flex items-center gap-2">
          {editable && hasContent && (
            <button
              onClick={toggleEdit}
              className="flex items-center gap-2 rounded-lg bg-white/20 px-3.5 py-2 text-sm font-semibold text-white ring-1 ring-white/30 transition-colors hover:bg-white/30"
            >
              {editMode ? (
                <>
                  <Check className="h-4 w-4" /> Done
                </>
              ) : (
                <>
                  <Pencil className="h-4 w-4" /> Edit
                </>
              )}
            </button>
          )}
          <button
            onClick={onSave}
            disabled={!hasContent || editMode}
            className="flex items-center gap-2 rounded-lg bg-white/20 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/30 transition-colors hover:bg-white/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>

      {/* Audio player — stays available in playback (hidden while editing). */}
      {audioUrl && !editMode && (
        <div className="shrink-0 border-b border-white/60 bg-white/40 px-6 py-4">
          <audio
            src={audioUrl}
            controls
            className="w-full"
            onTimeUpdate={(e) => setPlaybackTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setPlaybackTime(e.currentTarget.currentTime)}
          />
          <p className="mt-2 bg-linear-to-r from-indigo-500 to-blue-500 bg-clip-text text-[11px] font-semibold uppercase tracking-widest text-transparent">
            Play to highlight the transcript in sync
          </p>
        </div>
      )}

      {/* Body — constrained to the card; scrolls internally instead of growing. */}
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-6">
        {editMode ? (
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onTranscriptEdit?.(e.target.value);
            }}
            placeholder="Edit the transcript..."
            className="h-full min-h-[300px] w-full resize-none rounded-xl border border-slate-200 bg-white/80 p-4 text-[15px] leading-relaxed text-slate-700 outline-none focus:ring-2 focus:ring-violet-500/40"
          />
        ) : !hasContent ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-slate-400">Listening for voices...</p>
          </div>
        ) : inPlayback ? (
          <div className="space-y-4">
            {segments.map((seg, i) => (
              <div
                key={i}
                className="border-b border-gray-100 pb-4 last:border-b-0"
              >
                {/* Colored speaker name above the spoken text (no avatar/timestamp) */}
                <p
                  className={`mb-1 text-sm font-bold ${
                    speakerColors[seg.speaker] || "text-slate-700"
                  }`}
                >
                  {seg.speaker}
                </p>
                <p className="text-[15px] leading-relaxed text-slate-700">
                  {seg.words && seg.words.length > 0
                    ? seg.words.map((w, wi) => (
                        <span
                          key={wi}
                          className={`transition-colors ${
                            isWordActive(w)
                              ? "rounded bg-violet-200 px-0.5 text-violet-900"
                              : ""
                          }`}
                        >
                          {w.word}{" "}
                        </span>
                      ))
                    : stripSpeakerPrefix(seg.text)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">
            {transcriptText}
          </p>
        )}
        {/* Auto-scroll anchor — kept in view as the transcript grows. */}
        <div ref={endRef} />
      </div>
    </div>
  );
}
