"use client";
import { useRef, useState } from "react";
import {
  Radio,
  Upload,
  Mic,
  Square,
  Pause,
  Play,
  FileAudio,
  Globe,
  Activity,
} from "lucide-react";
import type { CaptureTab } from "./Dashboard";
import SiriWave from "./SiriWave";

function formatTime(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

type CaptureControlsProps = {
  isRecording: boolean;
  isPaused: boolean;
  sessionTime: number;
  activeTab: CaptureTab;
  systemStatus: string;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onTabChange: (tab: CaptureTab) => void;

  uploadFile: File | null;
  isUploading: boolean;
  uploadProgress: number;
  onSelectFile: (file: File) => void;
  onProcessUpload: () => void;

  micLabel?: string;
  detectedLanguage?: string;
  audioQuality?: string;
};

const cardClass =
  "rounded-2xl border border-white/60 bg-white/60 backdrop-blur-xl shadow-[0_8px_30px_rgb(0,0,0,0.06)]";

export default function CaptureControls({
  isRecording,
  isPaused,
  sessionTime,
  activeTab,
  systemStatus,
  onStart,
  onPause,
  onResume,
  onStop,
  onTabChange,
  uploadFile,
  isUploading,
  uploadProgress,
  onSelectFile,
  onProcessUpload,
  micLabel = "Default Microphone",
  detectedLanguage = "English",
  audioQuality = "Medium",
}: CaptureControlsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const isActive = isRecording && !isPaused;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div className={`${cardClass} px-5 py-4`}>
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          System Status
        </p>
        <p
          className={`mt-1 text-lg font-bold ${
            isActive ? "text-violet-600" : "text-slate-800"
          }`}
        >
          {isUploading ? "Uploading..." : systemStatus}
        </p>
      </div>

      <div className="flex rounded-xl border border-white/60 bg-white/40 p-1 backdrop-blur-md">
        {(
          [
            { key: "live", label: "Live Feed", Icon: Radio },
            { key: "upload", label: "Upload File", Icon: Upload },
          ] as const
        ).map(({ key, label, Icon }) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              onClick={() => onTabChange(key)}
              disabled={isRecording}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          );
        })}
      </div>

      <div
        className={`${cardClass} flex flex-1 flex-col items-center justify-between gap-6 p-6`}
      >
        {activeTab === "live" ? (
          <>
            <div className="flex w-full flex-col items-center gap-4">
              <div className="relative my-2 h-80 w-80 shrink-0">
                <SiriWave isRecording={isRecording} isPaused={isPaused} />
                <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    Session Time
                  </span>
                  <span className="font-mono text-2xl font-black tracking-tight text-slate-800 tabular-nums">
                    {formatTime(sessionTime)}
                  </span>
                </div>
              </div>

              {/* FIXED DYNAMIC UI BLOCK FOR MIC & LANGUAGE */}
              <div className="flex w-full max-w-[280px] flex-col items-center gap-2">
                {/* Mic Indicator */}
                <div className="flex w-full items-center justify-center gap-1.5 rounded-full border border-white/60 bg-white/50 px-4 py-2 text-xs font-semibold text-slate-600 shadow-sm backdrop-blur-md">
                  <Mic className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                  <span className="truncate" title={micLabel}>
                    {micLabel}
                  </span>
                </div>

                {/* Language & Quality Indicators */}
                <div className="flex w-full items-center justify-between gap-2">
                  <div className="flex flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-full border border-white/60 bg-white/50 px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm backdrop-blur-md">
                    <Globe className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                    <span
                      className="truncate"
                      title={
                        detectedLanguage === "Auto-detect"
                          ? "Detecting..."
                          : detectedLanguage
                      }
                    >
                      {detectedLanguage === "Auto-detect"
                        ? "Detecting..."
                        : detectedLanguage}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-white/60 bg-white/50 px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm backdrop-blur-md">
                    <Activity
                      className={`h-3.5 w-3.5 ${
                        audioQuality === "Good"
                          ? "text-emerald-500"
                          : audioQuality === "Medium"
                            ? "text-amber-500"
                            : "text-rose-500"
                      }`}
                    />
                    <span>{audioQuality}</span>
                  </div>
                </div>
              </div>
              {/* END OF FIXED UI BLOCK */}
            </div>

            <div className="flex w-full flex-col items-center gap-4">
              <div className="flex h-5 items-center justify-center">
                {isActive ? (
                  <div className="flex items-end gap-1">
                    {[0.45, 0.75, 1, 0.6, 0.85, 0.5].map((h, i) => (
                      <span
                        key={i}
                        className="w-1 animate-pulse rounded-full bg-linear-to-t from-violet-500 to-blue-500"
                        style={{
                          height: `${h * 20}px`,
                          animationDelay: `${i * 120}ms`,
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs font-medium text-slate-400">
                    {isPaused
                      ? "Paused — resume when you're ready"
                      : "Ready to capture meeting insights…"}
                  </p>
                )}
              </div>

              {!isRecording ? (
                <button
                  onClick={onStart}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-4 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600 active:scale-[0.99]"
                >
                  <Mic className="h-4 w-4" /> Start Recording
                </button>
              ) : (
                <div className="flex w-full gap-3">
                  {isPaused ? (
                    <button
                      onClick={onResume}
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-4 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600 active:scale-[0.99]"
                    >
                      <Play className="h-4 w-4 fill-current" /> Resume
                    </button>
                  ) : (
                    <button
                      onClick={onPause}
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-linear-to-r from-amber-400 to-amber-500 py-4 text-sm font-bold text-white shadow-lg shadow-amber-500/25 transition-all hover:from-amber-500 hover:to-amber-600 active:scale-[0.99]"
                    >
                      <Pause className="h-4 w-4 fill-current" /> Pause
                    </button>
                  )}
                  <button
                    onClick={onStop}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-linear-to-r from-rose-500 to-red-500 py-4 text-sm font-bold text-white shadow-lg shadow-red-500/25 transition-all hover:from-rose-600 hover:to-red-600 active:scale-[0.99]"
                  >
                    <Square className="h-4 w-4 fill-current" /> Stop
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) onSelectFile(f);
              }}
              className={`flex w-full flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
                isDragging
                  ? "border-violet-400 bg-violet-50/60"
                  : "border-slate-300 bg-white/40 hover:bg-white/70"
              }`}
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-linear-to-br from-violet-500/15 to-blue-500/15">
                {uploadFile ? (
                  <FileAudio className="h-6 w-6 text-violet-600" />
                ) : (
                  <Upload className="h-6 w-6 text-violet-600" />
                )}
              </div>
              <p className="break-all px-2 text-sm font-semibold text-slate-700">
                {uploadFile
                  ? uploadFile.name
                  : "Drag & drop a file, or click to browse"}
              </p>
              <p className="text-xs text-slate-400">
                Audio or video meeting files
              </p>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onSelectFile(f);
                }}
              />
            </div>

            {isUploading && (
              <div className="w-full">
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/70">
                  <div
                    className="h-full rounded-full bg-linear-to-r from-violet-500 to-blue-500 transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            <button
              onClick={onProcessUpload}
              disabled={!uploadFile || isUploading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-4 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isUploading ? "Processing..." : "Process File"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
