"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  VolumeX,
  Download,
  RotateCcw,
  RotateCw,
} from "lucide-react";

function fmt(total: number): string {
  if (!Number.isFinite(total) || total < 0) total = 0;
  const s = Math.floor(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export default function AudioPlayer({
  src,
  audioRef,
  onTimeUpdate,
}: {
  src: string;
  audioRef?: RefObject<HTMLAudioElement | null>;
  onTimeUpdate?: (t: number) => void;
}) {
  const localRef = useRef<HTMLAudioElement | null>(null);
  const ref = audioRef ?? localRef;
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);
  const [showVolume, setShowVolume] = useState(false);

  const speedWrapRef = useRef<HTMLDivElement | null>(null);
  const volumeWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.playbackRate = rate;
  }, [rate, ref, src]);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.volume = volume;
      el.muted = muted || volume === 0;
    }
  }, [volume, muted, ref, src]);

  useEffect(() => {
    if (!showSpeed && !showVolume) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (speedWrapRef.current && !speedWrapRef.current.contains(t)) {
        setShowSpeed(false);
      }
      if (volumeWrapRef.current && !volumeWrapRef.current.contains(t)) {
        setShowVolume(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showSpeed, showVolume]);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const seek = (v: number) => {
    const el = ref.current;
    if (el) el.currentTime = v;
  };

  const skip = (delta: number) => {
    const el = ref.current;
    if (!el) return;
    const next = Math.min(Math.max(el.currentTime + delta, 0), duration || el.currentTime + delta);
    el.currentTime = next;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || !el.src) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        skip(5);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        skip(-5);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  const pickSpeed = (s: number) => {
    setRate(s);
    setShowSpeed(false);
  };

  const download = async () => {
    const api = (
      window as unknown as {
        electronAPI?: {
          saveAudio?: (
            src: string,
            defaultName?: string,
          ) => Promise<{ saved: boolean }>;
        };
      }
    ).electronAPI;
    if (api?.saveAudio && src.startsWith("media://")) {
      await api.saveAudio(src, "recording.ogg");
      return;
    }
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = "recording.ogg";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {}
  };

  const pct = duration ? (current / duration) * 100 : 0;
  const volPct = (muted ? 0 : volume) * 100;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  const seekFill = `linear-gradient(to right, #2FB5AA 0%, #2FB5AA ${pct}%, #E2E8F0 ${pct}%, #E2E8F0 100%)`;
  const volFill = `linear-gradient(to right, #2FB5AA 0%, #2FB5AA ${volPct}%, #E2E8F0 ${volPct}%, #E2E8F0 100%)`;

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-white/60 bg-white/70 px-3 py-2.5 shadow-sm sm:gap-3">
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => skip(-15)}
          aria-label="Back 15 seconds"
          title="Back 15 seconds"
          className="relative flex h-9 w-9 items-center justify-center text-slate-500 transition-colors hover:text-[#2E6DBE]"
        >
          <RotateCcw className="h-6 w-6" strokeWidth={2} />
          <span className="absolute text-[8px] font-bold leading-none">15</span>
        </button>

        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-linear-to-br from-[#2FB5AA] to-[#2E6DBE] text-white shadow-md transition-transform hover:scale-105 active:scale-95"
        >
          {playing ? (
            <Pause className="h-5 w-5 fill-current" />
          ) : (
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          )}
        </button>

        <button
          type="button"
          onClick={() => skip(15)}
          aria-label="Forward 15 seconds"
          title="Forward 15 seconds"
          className="relative flex h-9 w-9 items-center justify-center text-slate-500 transition-colors hover:text-[#2E6DBE]"
        >
          <RotateCw className="h-6 w-6" strokeWidth={2} />
          <span className="absolute text-[8px] font-bold leading-none">15</span>
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="0.1"
          value={Math.min(current, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          className="audio-range h-1.5 w-full cursor-pointer appearance-none rounded-full"
          style={{ background: seekFill }}
        />
        <div className="flex justify-between font-mono text-[11px] font-semibold tabular-nums text-slate-500">
          <span>{fmt(current)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      <div ref={speedWrapRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => {
            setShowSpeed((v) => !v);
            setShowVolume(false);
          }}
          aria-label="Playback speed"
          title="Playback speed"
          className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-200"
        >
          {rate}x
        </button>
        {showSpeed && (
          <div className="absolute bottom-full right-0 z-20 mb-2 flex max-w-[90vw] items-center gap-0.5 overflow-x-auto rounded-lg border border-slate-200 bg-white px-1.5 py-1 shadow-lg">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pickSpeed(s)}
                className={`whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums transition-colors hover:bg-slate-100 ${
                  s === rate ? "bg-slate-100 text-[#2FB5AA]" : "text-slate-600"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>
        )}
      </div>

      <div ref={volumeWrapRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => {
            setShowVolume((v) => !v);
            setShowSpeed(false);
          }}
          aria-label="Volume"
          title="Volume"
          className="flex items-center text-slate-500 transition-colors hover:text-slate-700"
        >
          <VolIcon className="h-5 w-5" />
        </button>
        {showVolume && (
          <div className="absolute bottom-full left-1/2 z-20 mb-2 flex -translate-x-1/2 items-center rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg">
            <input
              type="range"
              min={0}
              max={1}
              step="0.01"
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                setMuted(v === 0);
              }}
              aria-label="Volume level"
              className="audio-range h-1.5 w-28 cursor-pointer appearance-none rounded-full"
              style={{ background: volFill }}
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={download}
        aria-label="Download audio"
        title="Download audio"
        className="shrink-0 text-slate-500 transition-colors hover:text-slate-700"
      >
        <Download className="h-5 w-5" />
      </button>

      <audio
        ref={ref}
        src={src}
        preload="metadata"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration || 0);
          e.currentTarget.playbackRate = rate;
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setCurrent(t);
          onTimeUpdate?.(t);
        }}
        onSeeked={(e) => {
          const t = e.currentTarget.currentTime;
          setCurrent(t);
          onTimeUpdate?.(t);
        }}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}
