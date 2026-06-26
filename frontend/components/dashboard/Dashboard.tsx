"use client";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Check, Upload } from "lucide-react";
import { useGlobalRecording } from "@/components/GlobalRecordingProvider";
import MyMeetings from "@/components/MyMeetings";
import Sidebar, { type DashboardView } from "./Sidebar";
import CaptureControls from "./CaptureControls";
import TranscriptArea from "./TranscriptArea";
import {
  loadMeetings,
  addMeeting,
  MEETINGS_EVENT,
} from "@/lib/meetingStore";
import { getUserName, clearSession } from "@/lib/auth";
import ConfirmModal from "@/components/ui/ConfirmModal";

type TranscriptWord = {
  word: string;
  start: number;
  end: number;
};

type MergedTranscriptRow = {
  speaker: string;
  text: string;
  start: number;
  end: number;
  words?: TranscriptWord[];
};

export type CaptureTab = "live" | "upload";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const stripSpeakerPrefix = (text: string) => text.replace(/^\[.*?\]\s*/, "");

const SPEAKER_PALETTE = [
  "text-indigo-600",
  "text-orange-500",
  "text-emerald-600",
  "text-rose-500",
  "text-violet-600",
  "text-amber-600",
];

function formatTime(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function AmbientGlow() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_35%_at_18%_12%,rgba(99,102,241,0.10),transparent_60%),radial-gradient(45%_40%_at_85%_88%,rgba(139,92,246,0.10),transparent_60%)]"
    />
  );
}

export default function Dashboard() {
  const router = useRouter();

  const [view, setView] = useState<DashboardView>("dashboard");
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [sessionTime, setSessionTime] = useState(0);
  const [activeTab, setActiveTab] = useState<CaptureTab>("live");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [meetingsCount, setMeetingsCount] = useState(0);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const [lines, setLines] = useState<string[]>([]);
  const [interim, setInterim] = useState("");
  const transcriptText = useMemo(
    () => [...lines, interim].filter(Boolean).join("\n\n"),
    [lines, interim],
  );

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [mergedTranscript, setMergedTranscript] = useState<MergedTranscriptRow[]>([]);
  const [isDiarizing, setIsDiarizing] = useState(false);
  const [currentAudioTime, setCurrentAudioTime] = useState(0);
  const [mergedEditMode, setMergedEditMode] = useState(false);
  const [mergedDraft, setMergedDraft] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [showFinishModal, setShowFinishModal] = useState(false);
  const [showNewConvoModal, setShowNewConvoModal] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);

  useEffect(() => {
    setUserName(getUserName());
  }, []);

  const startedAtRef = useRef<number>(0);
  const sessionIdRef = useRef(0);
  const liveRef = useRef(false);
  const interimRef = useRef("");
  const interimRafRef = useRef<number | null>(null);

  const handleAzurePartial = useCallback((text: string) => {
    if (!liveRef.current) return;
    interimRef.current = text;
    if (interimRafRef.current == null) {
      interimRafRef.current = requestAnimationFrame(() => {
        interimRafRef.current = null;
        setInterim(interimRef.current);
      });
    }
  }, []);

  const handleAzureFinal = useCallback((text: string) => {
    if (!liveRef.current) return;
    if (interimRafRef.current != null) {
      cancelAnimationFrame(interimRafRef.current);
      interimRafRef.current = null;
    }
    interimRef.current = "";
    setInterim("");
    setLines((prev) => [...prev, text]);
  }, []);

  const handleAzureError = useCallback((msg: string) => {
    if (msg) setStatusMessage(`⚠️ ${msg}`);
  }, []);

  const {
    start,
    pause,
    resume,
    finishAndUpload,
    cancel,
    micLabel,
    detectedLanguage,
    audioQuality,
    setCallbacks,
  } = useGlobalRecording();

  useEffect(() => {
    setCallbacks({
      onPartial: handleAzurePartial,
      onFinal: handleAzureFinal,
      onError: handleAzureError,
    });
  }, [handleAzurePartial, handleAzureFinal, handleAzureError, setCallbacks]);

  useEffect(() => {
    return () => {
      if (interimRafRef.current != null) {
        cancelAnimationFrame(interimRafRef.current);
      }
    };
  }, []);

  const stopLiveEvents = useCallback(() => {
    liveRef.current = false;
    if (interimRafRef.current != null) {
      cancelAnimationFrame(interimRafRef.current);
      interimRafRef.current = null;
    }
    interimRef.current = "";
  }, []);

  const systemStatus =
    statusMessage ??
    (isPaused ? "Paused" : isRecording ? "Listening..." : "Ready");

  useEffect(() => {
    if (!isRecording || isPaused) return;
    const id = setInterval(() => {
      setSessionTime(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, [isRecording, isPaused]);

  useEffect(() => {
    const read = () => setMeetingsCount(loadMeetings().length);
    read();
    window.addEventListener(MEETINGS_EVENT, read);
    return () => window.removeEventListener(MEETINGS_EVENT, read);
  }, [view]);

  const saveTranscriptLocally = useCallback(
    async (rows: MergedTranscriptRow[]) => {
      if (!rows.length) return;
      const electron =
        typeof window !== "undefined" ? window.electronAPI : undefined;
      if (!electron?.saveTranscriptLocal) return;
      try {
        const payload = {
          createdAt: new Date().toISOString(),
          merged_transcript: rows,
        };
        await electron.saveTranscriptLocal(payload, "ThreadNotes-Transcript");
      } catch (e) {
        console.warn("Local transcript save failed:", e);
      }
    },
    [],
  );

  const mergedPlainText = useMemo(
    () =>
      mergedTranscript
        .map((r) => `${r.speaker}: ${stripSpeakerPrefix(r.text)}`)
        .join("\n\n"),
    [mergedTranscript],
  );

  const speakerColors = useMemo(() => {
    const map: Record<string, string> = {};
    mergedTranscript.forEach((r) => {
      if (!(r.speaker in map)) {
        map[r.speaker] =
          SPEAKER_PALETTE[Object.keys(map).length % SPEAKER_PALETTE.length];
      }
    });
    return map;
  }, [mergedTranscript]);

  // When a new transcript loads, reset the audio element to the start so the
  // sync highlighting lines up with the freshly-loaded source.
  useEffect(() => {
    if (mergedTranscript.length === 0) return;
    setCurrentAudioTime(0);
    const el = audioRef.current;
    if (el) {
      el.currentTime = 0;
      el.load();
    }
  }, [mergedTranscript, audioUrl]);

  const toggleMergedEdit = useCallback(() => {
    setMergedEditMode((on) => {
      if (!on) {
        setMergedDraft(mergedPlainText);
        return true;
      }
      // Commit edits back onto the rows, preserving timestamps so highlighting
      // keeps working. Only applied when the paragraph count still maps 1:1.
      const paras = mergedDraft
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (paras.length === mergedTranscript.length) {
        setMergedTranscript((prev) =>
          prev.map((row, i) => {
            const p = paras[i];
            const colon = p.indexOf(":");
            const text = colon >= 0 ? p.slice(colon + 1).trim() : p;
            return { ...row, text };
          }),
        );
      }
      return false;
    });
  }, [mergedDraft, mergedPlainText, mergedTranscript.length]);

  const clearPlayback = useCallback(() => {
    setMergedEditMode(false);
    setMergedTranscript([]);
    setCurrentAudioTime(0);
    setAudioUrl((prev) => {
      if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const handleStart = useCallback(async () => {
    sessionIdRef.current += 1;
    clearPlayback();
    setLines([]);
    setInterim("");
    setMergedTranscript([]);
    setSessionTime(0);
    setStatusMessage(null);
    const ok = await start();
    if (ok) {
      startedAtRef.current = Date.now();
      liveRef.current = true;
      setIsRecording(true);
      setIsPaused(false);
      setStatusMessage("Listening...");
    } else {
      setStatusMessage("⚠️ Couldn't start recording");
    }
  }, [start, clearPlayback]);

  const handlePause = useCallback(() => {
    pause();
    setIsPaused(true);
    setStatusMessage("Paused");
  }, [pause]);

  const handleResume = useCallback(() => {
    startedAtRef.current = Date.now() - sessionTime * 1000;
    resume();
    setIsPaused(false);
    setStatusMessage("Listening...");
  }, [resume, sessionTime]);

  const confirmFinish = useCallback(async () => {
    const sid = sessionIdRef.current;
    stopLiveEvents();
    setShowFinishModal(false);
    setIsRecording(false);
    setIsPaused(false);
    setIsDiarizing(true);
    setStatusMessage("Processing Audio & Diarizing...");
    try {
      const result = await finishAndUpload();
      if (sid !== sessionIdRef.current) return;
      if (result?.audioUrl) {
        setCurrentAudioTime(0);
        setAudioUrl((prev) => {
          if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
          return result.audioUrl;
        });
      }
      if (Array.isArray(result?.merged_transcript)) {
        const rows = result.merged_transcript as MergedTranscriptRow[];
        setMergedTranscript(rows);
        setLines([]);
        setInterim("");
        void saveTranscriptLocally(rows);
      }
      setStatusMessage(
        result?.status === "success"
          ? "Meeting transcript is ready"
          : "Recording finished",
      );
    } catch (e: any) {
      if (sid !== sessionIdRef.current) return;
      setStatusMessage(`⚠️ ${e?.message || "Finish failed"}`);
    } finally {
      setIsDiarizing(false);
    }
  }, [finishAndUpload, stopLiveEvents, saveTranscriptLocally]);

  const handleProcessUpload = useCallback(async () => {
    if (!uploadFile) return;
    const sid = sessionIdRef.current;
    clearPlayback();
    setLines([]);
    setInterim("");
    setMergedTranscript([]);
    setIsUploading(true);
    setUploadProgress(2);

    const token = localStorage.getItem("token");
    const electron =
      typeof window !== "undefined" ? window.electronAPI : undefined;
    const localPath = electron?.getPathForFile?.(uploadFile) || "";

    // Uploaded files live outside the recordings dir, so the media:// scheme
    // can't serve them. A same-origin blob URL plays reliably in the sandboxed
    // renderer (and is revoked in clearPlayback). Avoids the file:// block.
    const playbackUrl = URL.createObjectURL(uploadFile);
    setCurrentAudioTime(0);
    setAudioUrl(playbackUrl);

    const finish = (rows: MergedTranscriptRow[], doneMsg: string) => {
      setUploadProgress(100);
      setTimeout(() => {
        if (sid !== sessionIdRef.current) return;
        setIsUploading(false);
        setUploadProgress(0);
        if (rows.length > 0) {
          setMergedTranscript(rows);
          setLines([]);
          setStatusMessage("Analysis ready!");
          setActiveTab("live");
          void saveTranscriptLocally(rows);
        } else {
          setStatusMessage(doneMsg);
        }
      }, 300);
    };

    try {
      if (electron?.audioCompressAndRead && localPath) {
        setStatusMessage("Compressing audio...");
        const climb = setInterval(
          () => setUploadProgress((p) => (p < 40 ? p + 4 : p)),
          600,
        );
        const { chunks, segmentSeconds, mimeType } =
          await electron.audioCompressAndRead(localPath);
        clearInterval(climb);
        if (sid !== sessionIdRef.current) return;

        const stitched: MergedTranscriptRow[] = [];
        for (let i = 0; i < chunks.length; i++) {
          setStatusMessage(
            chunks.length > 1
              ? `Diarizing part ${i + 1} of ${chunks.length}...`
              : "Diarizing with GPT-4o...",
          );
          const form = new FormData();
          form.append(
            "file",
            new Blob([chunks[i].buffer], { type: mimeType }),
            chunks[i].name,
          );
          const res = await fetch(`${API_URL}/diarize/stream`, {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            body: form,
          });
          const data = await res.json();
          if (sid !== sessionIdRef.current) return;
          if (!res.ok || data.status === "error") {
            throw new Error(
              data.detail || data.message ||
                `Diarization failed on part ${i + 1}`,
            );
          }
          const offset = i * segmentSeconds;
          const segs = (Array.isArray(data.merged_transcript)
            ? data.merged_transcript
            : Array.isArray(data.segments)
              ? data.segments
              : []) as MergedTranscriptRow[];
          for (const s of segs) {
            stitched.push({
              ...s,
              start: (Number(s.start) || 0) + offset,
              end: (Number(s.end) || 0) + offset,
              words: s.words?.map((w) => ({
                ...w,
                start: (Number(w.start) || 0) + offset,
                end: (Number(w.end) || 0) + offset,
              })),
            });
          }
          setUploadProgress(40 + Math.round(((i + 1) / chunks.length) * 55));
        }

        finish(stitched, "No speech detected in the uploaded file.");
        return;
      }

      setStatusMessage("Uploading & diarizing with GPT-4o...");
      const climb = setInterval(
        () => setUploadProgress((p) => (p < 90 ? p + 3 : p)),
        1000,
      );
      const form = new FormData();
      form.append("file", uploadFile);
      const res = await fetch(`${API_URL}/diarize/stream`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      const data = await res.json();
      clearInterval(climb);
      if (sid !== sessionIdRef.current) return;
      if (!res.ok || data.status === "error") {
        setIsUploading(false);
        setUploadProgress(0);
        setStatusMessage(
          data.detail || data.message || "Failed to process file.",
        );
        return;
      }
      finish(
        Array.isArray(data.segments)
          ? (data.segments as MergedTranscriptRow[])
          : [],
        "No speech detected in the uploaded file.",
      );
    } catch (e: any) {
      if (sid !== sessionIdRef.current) return;
      setIsUploading(false);
      setUploadProgress(0);
      setStatusMessage(e?.message || "Could not process the file.");
    }
  }, [uploadFile, clearPlayback, saveTranscriptLocally]);

  const handleSaveTranscript = useCallback(async () => {
    if (!transcriptText.trim() && mergedTranscript.length === 0) return;
    const defaultName = `ThreadNotes_Transcript_${new Date().toISOString().slice(0, 10)}.txt`;

    try {
      if (typeof window !== "undefined" && window.electronAPI) {
        const result = await window.electronAPI.saveTranscript(
          transcriptText,
          defaultName,
        );
        if (!result.saved) {
          setStatusMessage("Ready");
          return;
        }
      } else {
        const blob = new Blob([transcriptText], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = defaultName;
        a.click();
        URL.revokeObjectURL(url);
      }

      const entries =
        mergedTranscript.length > 0
          ? mergedTranscript.map((item) => ({
              speaker: item.speaker,
              text: stripSpeakerPrefix(item.text),
              timestamp: "",
            }))
          : lines.map((l) => ({ speaker: "Speaker", text: l, timestamp: "" }));
      const firstWords =
        entries[0]?.text.split(" ").slice(0, 5).join(" ") || "Discussion";
      const record = {
        id: Date.now().toString(),
        topic: `Meeting on ${firstWords}...`,
        date: new Date().toISOString(),
        transcript: entries,
      };
      addMeeting(record);
      setStatusMessage("✅ Saved!");
    } catch {
      setStatusMessage("⚠️ Save failed");
    }
  }, [transcriptText, mergedTranscript, lines]);

  const doReset = useCallback(() => {
    sessionIdRef.current += 1;
    stopLiveEvents();
    if (isRecording) cancel();
    clearPlayback();
    setIsRecording(false);
    setIsPaused(false);
    setSessionTime(0);
    setLines([]);
    setInterim("");
    setUploadFile(null);
    setStatusMessage(null);
    setActiveTab("live");
    setView("dashboard");
  }, [isRecording, cancel, clearPlayback, stopLiveEvents]);

  const handleNewConversationClick = useCallback(() => {
    if (isRecording || lines.length > 0 || mergedTranscript.length > 0) {
      setShowNewConvoModal(true);
    } else {
      doReset();
    }
  }, [isRecording, lines.length, mergedTranscript.length, doReset]);

  const handleLogout = useCallback(() => {
    stopLiveEvents();
    if (isRecording) cancel();
    clearSession();
    router.push("/auth");
  }, [isRecording, cancel, router, stopLiveEvents]);

  const handleDeleteAccount = useCallback(async () => {
    if (!deletePassword) {
      setDeleteError("Please enter your password to confirm.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/delete-account`, {
        method: "DELETE",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirm_password: deletePassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to delete account");
      }
      // Account is gone — stop everything and wipe all local session state.
      stopLiveEvents();
      if (isRecording) cancel();
      localStorage.clear();
      router.replace("/auth");
    } catch (e: any) {
      // Keep the modal open so the user can correct the password and retry.
      setDeleting(false);
      setDeleteError(e?.message || "Delete failed");
    }
  }, [isRecording, cancel, router, stopLiveEvents, deletePassword]);

  const closeDeleteModal = useCallback(() => {
    setShowDeleteModal(false);
    setDeletePassword("");
    setDeleteError(null);
  }, []);

  const handleTranscriptEdit = useCallback((text: string) => {
    setLines(text ? [text] : []);
    setInterim("");
  }, []);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 text-slate-800">
      <Sidebar
        activeView={view}
        onNavigate={setView}
        meetingsCount={meetingsCount}
        userName={userName}
        onLogout={() => setShowLogoutModal(true)}
        onDeleteAccount={() => setShowDeleteModal(true)}
      />

      <main className="relative flex flex-1 flex-col overflow-hidden">
        <AmbientGlow />

        {view === "dashboard" ? (
          <div className="relative z-10 flex h-full min-h-0 flex-col gap-4 px-3 py-4">
            <div className="mt-4 flex shrink-0 flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold tracking-tight text-slate-900">
                  Capture &amp; Analysis
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Record live audio or upload a meeting file to generate
                  structured transcripts instantly.
                </p>
              </div>
              <button
                onClick={handleNewConversationClick}
                className="flex items-center gap-2 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600 active:scale-[0.98]"
              >
                <Plus className="h-4 w-4" strokeWidth={2.5} />
                New Conversation
              </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-3">
              <div className="flex w-full shrink-0 flex-col lg:w-105">
                <CaptureControls
                  isRecording={isRecording}
                  isPaused={isPaused}
                  sessionTime={sessionTime}
                  activeTab={activeTab}
                  systemStatus={systemStatus}
                  onStart={handleStart}
                  onPause={handlePause}
                  onResume={handleResume}
                  onStop={() => setShowFinishModal(true)}
                  onTabChange={setActiveTab}
                  uploadFile={uploadFile}
                  isUploading={isUploading}
                  uploadProgress={uploadProgress}
                  onSelectFile={setUploadFile}
                  onProcessUpload={handleProcessUpload}
                  micLabel={micLabel}
                  detectedLanguage={detectedLanguage}
                  audioQuality={audioQuality}
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                {isDiarizing ? (
                  <div className="flex min-h-[320px] flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white/90 p-10 text-center shadow-sm shadow-slate-200/60">
                    <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-violet-50 text-violet-600 shadow-inner shadow-violet-100">
                      <span className="text-2xl font-black">⏳</span>
                    </div>
                    <h3 className="text-xl font-semibold text-slate-900">
                      Processing Audio &amp; Diarizing...
                    </h3>
                    <p className="mt-3 max-w-sm text-sm leading-6 text-slate-500">
                      The local AI engine is merging your live transcript with
                      speaker segments. This may take a few seconds.
                    </p>
                  </div>
                ) : mergedTranscript.length > 0 ? (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/60 bg-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.06)] backdrop-blur-xl">
                    <div className="flex items-center justify-between bg-linear-to-r from-violet-500 to-blue-500 px-6 py-4">
                      <h3 className="text-base font-bold text-white">
                        Playback &amp; Transcript
                      </h3>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={toggleMergedEdit}
                          className="flex items-center gap-2 rounded-lg bg-white/20 px-3.5 py-2 text-sm font-semibold text-white ring-1 ring-white/30 transition-colors hover:bg-white/30"
                        >
                          {mergedEditMode ? (
                            <>
                              <Check className="h-4 w-4" /> Done
                            </>
                          ) : (
                            <>
                              <Pencil className="h-4 w-4" /> Edit
                            </>
                          )}
                        </button>
                        <button
                          onClick={handleSaveTranscript}
                          disabled={mergedEditMode}
                          className="flex items-center gap-2 rounded-lg bg-white/20 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/30 transition-colors hover:bg-white/30 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Upload className="h-4 w-4" />
                          Save
                        </button>
                      </div>
                    </div>

                    {audioUrl && !mergedEditMode && (
                      <div className="shrink-0 border-b border-white/60 bg-white/40 px-6 py-4">
                        <audio
                          ref={audioRef}
                          src={audioUrl}
                          controls
                          className="w-full accent-violet-500"
                          onTimeUpdate={(e) =>
                            setCurrentAudioTime(e.currentTarget.currentTime)
                          }
                          onSeeked={(e) =>
                            setCurrentAudioTime(e.currentTarget.currentTime)
                          }
                        />
                        <p className="mt-2 bg-linear-to-r from-indigo-500 to-blue-500 bg-clip-text text-[11px] font-semibold uppercase tracking-widest text-transparent">
                          Play to highlight the transcript in sync
                        </p>
                      </div>
                    )}

                    <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-6">
                      {mergedEditMode ? (
                        <textarea
                          value={mergedDraft}
                          onChange={(e) => setMergedDraft(e.target.value)}
                          placeholder="Edit the transcript..."
                          className="h-full min-h-[300px] w-full resize-none rounded-xl border border-slate-200 bg-white/80 p-4 text-[15px] leading-relaxed text-slate-700 outline-none focus:ring-2 focus:ring-violet-500/40"
                        />
                      ) : (
                        <div className="space-y-3">
                          {mergedTranscript.map((item, index) => {
                            const speakerColor =
                              speakerColors[item.speaker] || "text-slate-700";
                            const words = item.words ?? [];

                            return (
                              <div
                                key={`${item.speaker}-${item.start}-${index}`}
                                className="rounded-xl border border-transparent bg-white/40 px-4 py-3"
                              >
                                <div className="mb-1 flex items-center gap-3">
                                  <p
                                    className={`text-sm font-bold ${speakerColor}`}
                                  >
                                    {item.speaker}
                                  </p>
                                </div>
                                <p className="text-[15px] leading-relaxed text-slate-700">
                                  {words.length > 0
                                    ? words.map((w, wi) => {
                                        const isActive =
                                          currentAudioTime >= w.start &&
                                          currentAudioTime < w.end;
                                        return (
                                          <span
                                            key={wi}
                                            className={
                                              isActive
                                                ? "text-indigo-600 font-bold transition-all"
                                                : "transition-all"
                                            }
                                          >
                                            {w.word}{" "}
                                          </span>
                                        );
                                      })
                                    : stripSpeakerPrefix(item.text)}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <TranscriptArea
                    transcriptText={transcriptText}
                    editable={!isRecording}
                    onSave={handleSaveTranscript}
                    onTranscriptEdit={handleTranscriptEdit}
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="relative z-10 min-h-0 flex-1">
            <MyMeetings />
          </div>
        )}
      </main>

      {isRecording && view !== "dashboard" && (
        <div className="fixed bottom-6 right-6 z-150 w-70 rounded-2xl border border-white/60 bg-white/80 p-4 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.18)] backdrop-blur-2xl">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-slate-700">
              <span className="relative flex h-2.5 w-2.5">
                {!isPaused && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-60" />
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                    isPaused ? "bg-slate-400" : "bg-rose-500"
                  }`}
                />
              </span>
              {isPaused ? "Paused" : "Listening"}
            </span>
            <span className="font-mono text-sm font-black tabular-nums text-slate-800">
              {formatTime(sessionTime)}
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={isPaused ? handleResume : handlePause}
              className={`flex-1 rounded-xl py-2.5 text-xs font-bold text-white shadow-md transition-all active:scale-95 ${
                isPaused
                  ? "bg-linear-to-r from-violet-500 to-blue-500 hover:from-violet-600 hover:to-blue-600"
                  : "bg-linear-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600"
              }`}
            >
              {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={() => {
                setView("dashboard");
                setShowFinishModal(true);
              }}
              className="flex-1 rounded-xl bg-linear-to-r from-rose-500 to-red-500 py-2.5 text-xs font-bold text-white shadow-md transition-all hover:from-rose-600 hover:to-red-600 active:scale-95"
            >
              Finish
            </button>
          </div>
        </div>
      )}

      {showFinishModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Finish recording?
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              We&apos;ll stop the live stream and generate the final
              speaker-tagged transcript.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowFinishModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmFinish}
                className="flex-1 rounded-xl bg-linear-to-r from-rose-500 to-red-500 py-3 text-sm font-bold text-white shadow-lg shadow-red-500/25 transition-all hover:from-rose-600 hover:to-red-600"
              >
                Finish
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewConvoModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Start a new conversation?
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              Unsaved progress will be lost.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowNewConvoModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowNewConvoModal(false);
                  doReset();
                }}
                className="flex-1 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600"
              >
                Start New
              </button>
            </div>
          </div>
        </div>
      )}

      {showLogoutModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">Log out?</h3>
            <p className="mt-2 text-sm text-slate-500">
              Are you sure you want to log out? Any active session will be
              stopped and unsaved data may be lost.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowLogoutModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowLogoutModal(false);
                  handleLogout();
                }}
                className="flex-1 rounded-xl bg-linear-to-r from-rose-500 to-red-500 py-3 text-sm font-bold text-white shadow-lg shadow-red-500/25 transition-all hover:from-rose-600 hover:to-red-600"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={showDeleteModal}
        danger
        loading={deleting}
        confirmDisabled={!deletePassword}
        title="Delete account?"
        message="This permanently deletes your account and cannot be undone. Enter your password to confirm."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDeleteAccount}
        onCancel={closeDeleteModal}
      >
        <input
          type="password"
          value={deletePassword}
          onChange={(e) => {
            setDeletePassword(e.target.value);
            if (deleteError) setDeleteError(null);
          }}
          placeholder="Current password"
          autoComplete="current-password"
          disabled={deleting}
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-200 disabled:opacity-50"
        />
        {deleteError && (
          <p className="mt-2 text-xs font-semibold text-rose-600">{deleteError}</p>
        )}
      </ConfirmModal>
    </div>
  );
}
