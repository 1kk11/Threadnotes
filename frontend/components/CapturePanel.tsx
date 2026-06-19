"use client";
import { useState, useRef, useEffect } from "react";
import { type TranscriptEntry } from "@/hooks/types";
import { useAzureSpeech } from "@/hooks/useAzureSpeech";

interface SiriWaveProps {
  isRecording: boolean;
  isPaused: boolean;
}

function SiriWave({ isRecording, isPaused }: SiriWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameId = useRef<number | null>(null);
  const phaseRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = canvas.width;
    let height = canvas.height;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      width = canvas.width;
      height = canvas.height;
    };
    resize();

    window.addEventListener("resize", resize);

    const waveList = [
      {
        frequency: 3,
        amplitude: 0.85,
        phaseOffset: 0,
        colorActive: "rgb(6, 182, 212)",
        glowActive: "rgba(6, 182, 212, 0.35)",
        colorIdle: "rgba(148, 163, 184, 0.5)",
        speed: 0.12,
      },
      {
        frequency: 4.5,
        amplitude: 0.65,
        phaseOffset: Math.PI / 3,
        colorActive: "rgb(168, 85, 247)",
        glowActive: "rgba(168, 85, 247, 0.3)",
        colorIdle: "rgba(148, 163, 184, 0.35)",
        speed: 0.08,
      },
      {
        frequency: 2.2,
        amplitude: 0.55,
        phaseOffset: Math.PI / 1.5,
        colorActive: "rgb(59, 130, 246)",
        glowActive: "rgba(59, 130, 246, 0.3)",
        colorIdle: "rgba(148, 163, 184, 0.45)",
        speed: 0.1,
      },
      {
        frequency: 5.5,
        amplitude: 0.4,
        phaseOffset: Math.PI,
        colorActive: "rgb(16, 185, 129)",
        glowActive: "rgba(16, 185, 129, 0.25)",
        colorIdle: "rgba(148, 163, 184, 0.3)",
        speed: 0.14,
      },
      {
        frequency: 3.8,
        amplitude: 0.75,
        phaseOffset: Math.PI * 1.5,
        colorActive: "rgb(244, 63, 94)",
        glowActive: "rgba(244, 63, 94, 0.3)",
        colorIdle: "rgba(148, 163, 184, 0.5)",
        speed: 0.07,
      },
    ];

    const render = () => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);

      if (isRecording && !isPaused) {
        phaseRef.current += 0.045;
      }

      const centerY = height / 2;
      const baseAmplitude = isRecording ? (isPaused ? 0.8 : 1.0) : 0.04;

      waveList.forEach((wave, index) => {
        ctx.globalCompositeOperation = "source-over";
        ctx.beginPath();

        let variation = 1.0;
        if (isRecording && !isPaused) {
          variation = 0.65 + 0.35 * Math.sin(phaseRef.current * 0.7 + index);
        }

        const amplitude =
          baseAmplitude * wave.amplitude * (height / 3.8) * variation;

        for (let x = 0; x < width; x++) {
          const normX = (x / width) * 2 - 1;
          const envelope = Math.pow(1 - normX * normX, 3);
          const wavePhase =
            phaseRef.current * (wave.speed / 0.045) + wave.phaseOffset;
          const y =
            centerY +
            Math.sin(normX * wave.frequency * Math.PI + wavePhase) *
              amplitude *
              envelope;

          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        if (isRecording) {
          ctx.strokeStyle = wave.glowActive;
          ctx.lineWidth = 10 * window.devicePixelRatio;
          ctx.shadowColor = "transparent";
          ctx.stroke();

          ctx.beginPath();
          for (let x = 0; x < width; x++) {
            const normX = (x / width) * 2 - 1;
            const envelope = Math.pow(1 - normX * normX, 3);
            const wavePhase =
              phaseRef.current * (wave.speed / 0.045) + wave.phaseOffset;
            const y =
              centerY +
              Math.sin(normX * wave.frequency * Math.PI + wavePhase) *
                amplitude *
                envelope;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = wave.colorActive;
          ctx.lineWidth = 2.5 * window.devicePixelRatio;
          ctx.stroke();
        } else {
          ctx.strokeStyle = wave.colorIdle;
          ctx.lineWidth = 2 * window.devicePixelRatio;
          ctx.stroke();
        }
      });

      animationFrameId.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", resize);
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, [isRecording, isPaused]);

  return <canvas ref={canvasRef} className="w-full h-full" />;
}

type Props = {
  transcript: TranscriptEntry[];
  isRecording: boolean;
  onTranscriptUpdate: (entry: TranscriptEntry) => void;
  onRecordingChange: (recording: boolean) => void;
  onTranscriptEdit?: (index: number, newText: string) => void;
  onClearTranscript: () => void;
  onReplaceTranscript?: (segments: any[]) => void;
  isHidden?: boolean;
};

type Phase = "idle" | "recording" | "paused";

export default function CapturePanel({
  transcript,
  onTranscriptUpdate,
  onRecordingChange,
  onTranscriptEdit,
  onClearTranscript,
  onReplaceTranscript,
  isHidden = false,
}: Props) {
  const [activeTab, setActiveTab] = useState<"record" | "upload">("record");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [editMode, setEditMode] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [showFinishModal, setShowFinishModal] = useState(false);

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const [interimText, setInterimText] = useState("");
  const [sessionTime, setSessionTime] = useState(0);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [showPlayback, setShowPlayback] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);

  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);

  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const prevLenRef = useRef<number>(transcript.length);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const { start, pause, resume, finishAndUpload, cancel } = useAzureSpeech({
    getAuthToken: () =>
      typeof window !== "undefined" ? localStorage.getItem("token") : null,
    // Azure `recognizing` -> typewriter interim line.
    onPartial: (text) => setInterimText(text),
    // Azure `recognized` -> commit a live bubble + clear the interim line.
    onFinal: (text) => {
      setInterimText("");
      onTranscriptUpdate({ speaker: "", text, timestamp: "", isFinal: false });
    },
    onError: (msg) => {
      if (msg) setStatusMessage(`⚠️ ${msg}`);
    },
  });

  const isActive = phase === "recording" || phase === "paused";

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (phase === "recording") {
      interval = setInterval(() => setSessionTime((prev) => prev + 1), 1000);
    }
    return () => clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (prevLenRef.current > 0 && transcript.length === 0) {
      if (phaseRef.current !== "idle") {
        cancel();
        onRecordingChange(false);
      }
      setPhase("idle");
      setSessionTime(0);
      setEditMode(false);
      setInterimText("");
      setShowPlayback(false);
      setPlaybackTime(0);
      setStatusMessage("Ready");
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    }
    prevLenRef.current = transcript.length;
  }, [transcript.length, cancel, onRecordingChange]);

  const formatTime = (totalSeconds: number) => {
    const h = Math.floor(totalSeconds / 3600)
      .toString()
      .padStart(2, "0");
    const m = Math.floor((totalSeconds % 3600) / 60)
      .toString()
      .padStart(2, "0");
    const s = (totalSeconds % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || editMode || isHidden || showPlayback) return;
    const isAtBottom =
      container.scrollHeight - container.scrollTop <=
      container.clientHeight + 150;
    if (isAtBottom) {
      transcriptEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [transcript, editMode, interimText, isHidden, showPlayback]);

  const handleStart = async () => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setShowPlayback(false);
    setPlaybackTime(0);

    const ok = await start();
    if (ok) {
      setPhase("recording");
      onRecordingChange(true);
      setStatusMessage("Listening...");
    }
  };

  const handlePauseResume = () => {
    if (phase === "recording") {
      pause();
      setPhase("paused");
      onRecordingChange(false);
      setStatusMessage("Paused");
    } else if (phase === "paused") {
      // resume() also silently reconnects if Azure dropped the socket while paused.
      void resume();
      setPhase("recording");
      onRecordingChange(true);
      setStatusMessage("Listening...");
    }
  };

  const confirmFinish = async () => {
    setShowFinishModal(false);
    setPhase("idle");
    onRecordingChange(false);
    setSessionTime(0);
    setInterimText("");
    setEditMode(false);
    setStatusMessage("Finalizing & diarizing...");

    try {
      // Stop live, upload the recording, get diarized segments + local audio URL.
      const result = await finishAndUpload();
      if (result?.audioUrl) {
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return result.audioUrl;
        });
        setShowPlayback(true);
      }
      if (
        Array.isArray(result?.segments) &&
        result.segments.length > 0 &&
        onReplaceTranscript
      ) {
        // Atomically swap the live draft for the final diarized transcript.
        onReplaceTranscript(result.segments);
      }
      setStatusMessage(
        result?.status === "success" ? "Playback ready" : "Recording finished",
      );
    } catch (e: any) {
      setStatusMessage(`⚠️ ${e?.message || "Finish failed"}`);
    }
  };

  const handleUploadDropzoneClick = () => {
    if (transcript.length > 0) {
      setPendingAction(
        () => () => document.getElementById("file-input")?.click(),
      );
      setShowUploadModal(true);
    } else {
      document.getElementById("file-input")?.click();
    }
  };

  const handleUpload = async () => {
    if (!uploadFile) return;
    onClearTranscript();
    setSessionTime(0);
    setShowPlayback(false);
    setIsUploading(true);
    setUploadProgress(2);
    setStatusMessage("Preparing report...");

    const safeFileName = encodeURIComponent(uploadFile.name);
    const progressInterval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/progress/${safeFileName}`);
        const data = await res.json();
        if (data.total > 0)
          setUploadProgress(Math.round((data.current / data.total) * 95));
      } catch (e) {
        console.error("Progress fetch failed");
      }
    }, 2000);

    const formData = new FormData();
    formData.append("file", uploadFile);
    formData.append("meeting_type", "Desktop Upload");

    try {
      const res = await fetch(`${API_URL}/transcribe`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      clearInterval(progressInterval);
      setUploadProgress(100);

      setTimeout(() => {
        setIsUploading(false);
        setUploadProgress(0);
        if (data.status === "success") {
          onTranscriptUpdate({
            speaker: "System",
            text: data.transcript,
            timestamp: "File",
          });
          setStatusMessage("Analysis ready!");
          setActiveTab("record");
        } else setStatusMessage("Failed to process.");
      }, 500);
    } catch {
      clearInterval(progressInterval);
      setIsUploading(false);
      setUploadProgress(0);
      setStatusMessage("Connection failed.");
    }
  };

  const handleSaveToComputer = async () => {
    if (transcript.length === 0) return;

    const textContent = transcript
      .map((t) => `${t.speaker || "Speaker"}: ${t.text}`)
      .join("\n\n");
    const defaultFileName = `ThreadNotes_Transcript_${new Date().toISOString().slice(0, 10)}.txt`;

    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.saveTranscript(
          textContent,
          defaultFileName,
        );
        if (!result.saved) {
          setStatusMessage("Ready");
          return;
        }
      } else {
        const blob = new Blob([textContent], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = defaultFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      const currentHistory = JSON.parse(
        localStorage.getItem("threadnotes_local_history") || "[]",
      );
      const firstFewWords =
        transcript[0]?.text.split(" ").slice(0, 5).join(" ") || "Discussion";
      const newRecord = {
        id: Date.now().toString(),
        topic: `Meeting on ${firstFewWords}...`,
        date: new Date().toISOString(),
        transcript: transcript,
      };

      localStorage.setItem(
        "threadnotes_local_history",
        JSON.stringify([newRecord, ...currentHistory]),
      );
      window.dispatchEvent(new Event("meetingSavedLocally"));
      setStatusMessage("✅ File Saved!");
    } catch (err: any) {
      console.error(err);
      setStatusMessage("❌ Save failed");
    }
  };

  const isWordActive = (start?: number, end?: number) =>
    showPlayback &&
    start != null &&
    end != null &&
    playbackTime >= start &&
    playbackTime < end;

  return (
    <>
      {isHidden && isActive && (
        <div className="fixed bottom-6 right-6 sm:bottom-8 sm:right-8 z-[200] w-[260px] sm:w-[280px] bg-white/90 backdrop-blur-2xl border border-slate-200/50 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.1)] rounded-2xl p-4 flex flex-col gap-3 animate-in slide-in-from-bottom-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative flex items-center justify-center w-4 h-4">
                {phase === "recording" && (
                  <span className="absolute w-full h-full bg-red-400 rounded-full animate-ping opacity-60"></span>
                )}
                <span
                  className={`relative w-2.5 h-2.5 rounded-full ${phase === "recording" ? "bg-red-500" : "bg-slate-400"}`}
                ></span>
              </div>
              <span className="text-xs font-black text-slate-700 uppercase tracking-widest">
                {phase === "recording" ? "Listening" : "Paused"}
              </span>
            </div>
            <span className="font-mono text-sm font-black text-slate-800 tracking-wider">
              {formatTime(sessionTime)}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handlePauseResume}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold text-white transition-all shadow-md active:scale-95 ${
                phase === "recording"
                  ? "bg-amber-500 hover:bg-amber-600 shadow-amber-500/20"
                  : "bg-indigo-600 hover:bg-indigo-700 shadow-indigo-600/20"
              }`}
            >
              {phase === "recording" ? "Pause" : "Continue"}
            </button>
            <button
              onClick={() => setShowFinishModal(true)}
              className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white bg-red-500 hover:bg-red-600 shadow-md shadow-red-500/20 transition-all active:scale-95"
            >
              Finish
            </button>
          </div>
        </div>
      )}

      <section
        className={`w-full h-full absolute inset-0 z-10 flex flex-col bg-slate-50 p-4 sm:p-6 pb-8 ${isHidden ? "hidden" : "flex"}`}
      >
        {isUploading && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-sm rounded-xl">
            <div className="bg-white p-8 rounded-2xl shadow-2xl border border-slate-100 max-w-sm w-full mx-4 flex flex-col items-center">
              <h3 className="text-lg font-black text-slate-900 mb-1">
                Processing...
              </h3>
              <div className="w-full bg-slate-100 rounded-full h-3 mb-2 shadow-inner overflow-hidden">
                <div
                  className="bg-indigo-600 h-full rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
            </div>
          </div>
        )}

        {showFinishModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-sm w-full shadow-2xl border border-slate-100">
              <h3 className="text-xl font-black text-slate-900 mb-2">
                Finish recording?
              </h3>
              <p className="text-sm text-slate-500 font-medium mb-8 leading-relaxed">
                Are you sure you want to finish and exit recording?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowFinishModal(false)}
                  className="flex-1 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmFinish}
                  className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-xl shadow-lg transition-all"
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        )}

        {showUploadModal && !isHidden && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-sm w-full shadow-2xl border border-slate-100">
              <h3 className="text-xl font-black text-slate-900 mb-2">
                Start fresh?
              </h3>
              <p className="text-sm text-slate-500 font-medium mb-8 leading-relaxed">
                Uploading a new file will clear your current transcript.
                Continue?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowUploadModal(false);
                    setPendingAction(null);
                  }}
                  className="flex-1 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onClearTranscript();
                    setSessionTime(0);
                    if (pendingAction) pendingAction();
                    setPendingAction(null);
                    setShowUploadModal(false);
                  }}
                  className="flex-1 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl shadow-lg transition-all"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Master Heading */}
        <div className="w-full flex-1 flex flex-col gap-6 min-h-0">
          <div className="flex flex-col gap-4 shrink-0">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
              <div>
                <h2 className="text-lg sm:text-xl font-bold text-slate-900">
                  Capture &amp; Analysis
                </h2>
                <p className="mt-1 text-sm text-slate-500 max-w-2xl">
                  Record live audio or upload a meeting file to generate
                  structured transcripts instantly.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-stretch flex-1 min-h-0 w-full mb-2">
            {/* Left Column - with overflow-y-auto to prevent buttons from pushing out */}
            <div className="w-full lg:w-2/5 flex flex-col gap-5 min-w-0 h-full">
              {/* System Status Box */}
              <div className="bg-white border border-slate-200 rounded-2xl flex flex-col overflow-hidden shrink-0 shadow-sm">
                <div className="px-4 py-4 border-b border-slate-200 flex flex-col justify-center min-h-[73px]">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                    System Status
                  </p>
                  <div className="flex items-center gap-2">
                    <p
                      className={`text-base font-bold ${phase === "recording" ? "text-indigo-600 animate-pulse" : "text-slate-800"}`}
                    >
                      {isUploading ? "Uploading..." : statusMessage}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex bg-slate-50 border border-slate-100 p-1 rounded-xl shrink-0">
                <button
                  onClick={() => setActiveTab("record")}
                  className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${activeTab === "record" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                >
                  Live Feed
                </button>
                <button
                  onClick={() => setActiveTab("upload")}
                  className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${activeTab === "upload" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                >
                  Upload File
                </button>
              </div>

              {/* Record/Upload Panel with custom scrollbar to handle small heights gracefully */}
              <div className="flex-1 flex flex-col bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-5 overflow-y-auto custom-scrollbar min-h-0 text-slate-800">
                {activeTab === "record" ? (
                  <div className="flex-1 flex flex-col items-center justify-between gap-6 py-2 w-full min-h-[300px]">
                    {/* SIRIWAVE ANIMATION - Scaled dynamically to fit small screens */}
                    <div className="relative w-40 h-40 sm:w-48 sm:h-48 shrink-0 flex items-center justify-center mx-auto my-auto rounded-full border-[3px] border-slate-200 shadow-[0_4px_24px_-4px_rgba(99,102,241,0.15),inset_0_1px_4px_rgba(0,0,0,0.04)] bg-white overflow-hidden">
                      <SiriWave
                        isRecording={
                          phase === "recording" || phase === "paused"
                        }
                        isPaused={phase === "paused"}
                      />
                    </div>

                    <div className="w-full flex flex-col items-center mt-auto shrink-0 pb-2">
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
                        Session Time
                      </p>
                      <p className="text-3xl sm:text-4xl font-black text-slate-800 font-mono tracking-tight mb-6">
                        {formatTime(sessionTime)}
                      </p>

                      {phase === "idle" ? (
                        <button
                          onClick={handleStart}
                          className="w-full py-4 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all shadow-md active:scale-[0.99]"
                        >
                          Start Recording
                        </button>
                      ) : (
                        <div className="w-full flex flex-col sm:flex-row flex-wrap gap-3">
                          <button
                            onClick={handlePauseResume}
                            className={`flex-1 min-w-[120px] py-4 rounded-xl font-bold text-white transition-all shadow-md active:scale-[0.99] ${
                              phase === "paused"
                                ? "bg-indigo-600 hover:bg-indigo-700"
                                : "bg-amber-500 hover:bg-amber-600"
                            }`}
                          >
                            {phase === "paused" ? "Continue" : "Pause"}
                          </button>
                          <button
                            onClick={() => setShowFinishModal(true)}
                            className="flex-1 min-w-[120px] py-4 rounded-xl font-bold text-white bg-red-500 hover:bg-red-600 transition-all shadow-md active:scale-[0.99]"
                          >
                            Finish Recording
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col gap-4 py-2 min-h-[300px]">
                    <div
                      className="w-full flex-1 flex flex-col items-center justify-center rounded-3xl border-2 border-dashed border-slate-300 bg-slate-50 hover:bg-indigo-50 transition-all cursor-pointer p-6 sm:p-8"
                      onClick={handleUploadDropzoneClick}
                    >
                      <svg
                        className="w-8 h-8 text-slate-400 mb-2"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                        />
                      </svg>
                      <p className="text-sm font-semibold text-slate-600 text-center break-all px-2">
                        {uploadFile
                          ? uploadFile.name
                          : "Click to select a file"}
                      </p>
                      <input
                        id="file-input"
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.[0])
                            setUploadFile(e.target.files[0]);
                        }}
                      />
                    </div>
                    <button
                      onClick={handleUpload}
                      disabled={!uploadFile || isUploading}
                      className="w-full py-4 bg-indigo-600 text-white font-bold rounded-xl disabled:opacity-50 shrink-0"
                    >
                      Process File
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column */}
            <div className="w-full lg:w-3/5 flex flex-col h-full min-h-[400px] lg:min-h-0 min-w-0">
              <div className="flex-1 bg-white border border-slate-200 rounded-2xl flex flex-col overflow-hidden shadow-sm min-h-0">
                {/* Box Header */}
                <div className="flex flex-col gap-3 px-4 sm:px-6 py-4 border-b border-slate-200 sm:flex-row sm:items-center sm:justify-between min-h-[73px] shrink-0">
                  <div>
                    <p className="text-sm font-bold text-slate-800">
                      {showPlayback
                        ? "Playback & Transcript"
                        : "Conversation Transcript"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {transcript.length > 0 && !isActive && (
                      <button
                        onClick={() => setEditMode(!editMode)}
                        className="flex items-center gap-2 px-4 py-2 border border-slate-200 rounded-lg text-sm font-bold text-slate-600 bg-white shadow-sm hover:bg-slate-50 transition-colors"
                      >
                        {editMode ? "✅ Done" : "✏️ Edit"}
                      </button>
                    )}

                    <button
                      onClick={handleSaveToComputer}
                      disabled={transcript.length === 0 || isActive}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 text-sm font-bold rounded-lg transition-colors shadow-sm disabled:cursor-not-allowed"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                        />
                      </svg>
                      Save
                    </button>
                  </div>
                </div>

                {showPlayback && audioUrl && (
                  <div className="shrink-0 px-4 sm:px-6 py-4 border-b border-slate-100 bg-slate-50/60">
                    <audio
                      ref={audioRef}
                      src={audioUrl}
                      controls
                      className="w-full"
                      onTimeUpdate={(e) =>
                        setPlaybackTime(e.currentTarget.currentTime)
                      }
                      onSeeked={(e) =>
                        setPlaybackTime(e.currentTarget.currentTime)
                      }
                    />
                    <p className="mt-2 text-[11px] font-semibold text-slate-400 uppercase tracking-widest">
                      Play to highlight the transcript in sync
                    </p>
                  </div>
                )}

                {/* Added massive bottom padding (pb-12 sm:pb-16) to fix text clipping at the bottom */}
                <div
                  ref={scrollContainerRef}
                  className="p-4 sm:p-6 pb-12 sm:pb-16 overflow-y-auto flex-1 custom-scrollbar"
                >
                  {transcript.length === 0 && !interimText ? (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-slate-400 text-sm">
                        Listening for voices...
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {transcript.map((entry, i) => {
                        let displaySpeaker = entry.speaker || "Speaker A";
                        let displayText = entry.text || "";

                        const speakerMatch =
                          displayText.match(/^\[(.*?)\]\s*(.*)/);
                        if (speakerMatch) {
                          displaySpeaker = speakerMatch[1];
                          displayText = speakerMatch[2];
                        }

                        if (
                          displaySpeaker.startsWith("Guest-") ||
                          displaySpeaker === "Unknown"
                        ) {
                          displaySpeaker = "Speaker A";
                        }

                        const phraseActive = isWordActive(
                          entry.start,
                          entry.end,
                        );

                        return (
                          <div
                            key={i}
                            className={`p-4 sm:p-5 rounded-xl border shadow-sm transition-colors ${
                              phraseActive && !entry.words?.length
                                ? "bg-indigo-50/70 border-indigo-200"
                                : "bg-white border-slate-200"
                            }`}
                          >
                            {editMode &&
                            !displayText.includes("[BACKGROUND") ? (
                              <div className="space-y-2">
                                <span className="inline-block px-2 py-0.5 bg-slate-100 rounded text-xs font-bold text-slate-700">
                                  {displaySpeaker}
                                </span>
                                <textarea
                                  value={displayText}
                                  onChange={(e) => {
                                    const newRawText = speakerMatch
                                      ? `[${displaySpeaker}] ${e.target.value}`
                                      : e.target.value;
                                    if (onTranscriptEdit)
                                      onTranscriptEdit(i, newRawText);
                                  }}
                                  className="w-full p-2 text-sm border border-slate-200 rounded-lg text-slate-700 resize-none outline-none focus:ring-2 focus:ring-indigo-500"
                                  rows={Math.max(
                                    2,
                                    Math.ceil(displayText.length / 60),
                                  )}
                                />
                              </div>
                            ) : (
                              <p className="text-[15px] leading-relaxed text-slate-700 whitespace-pre-wrap">
                                <span className="font-bold text-slate-900 mr-2">
                                  {displaySpeaker}:
                                </span>
                                {entry.words && entry.words.length > 0
                                  ? entry.words.map((w, wi) => (
                                      <span
                                        key={wi}
                                        className={`transition-colors ${
                                          isWordActive(w.start, w.end)
                                            ? "bg-indigo-200 text-indigo-900 rounded px-0.5"
                                            : ""
                                        }`}
                                      >
                                        {w.word}{" "}
                                      </span>
                                    ))
                                  : displayText}
                              </p>
                            )}
                          </div>
                        );
                      })}

                      {interimText && (
                        <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-sm">
                          <p className="text-[15px] text-slate-500 italic flex items-center gap-2">
                            <span className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse"></span>
                            {interimText}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  <div ref={transcriptEndRef} className="h-4" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
