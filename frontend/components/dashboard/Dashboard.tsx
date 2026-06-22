"use client";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useAzureSpeech } from "@/hooks/useAzureSpeech";
import MyMeetings from "@/components/MyMeetings";
import Sidebar, { type DashboardView } from "./Sidebar";
import CaptureControls from "./CaptureControls";
import TranscriptArea, { type Segment } from "./TranscriptArea";
import {
  loadMeetings,
  addMeeting,
  clearMeetings,
  MEETINGS_EVENT,
} from "@/lib/meetingStore";
import { getUserName, clearSession } from "@/lib/auth";
import ConfirmModal from "@/components/ui/ConfirmModal";

export type CaptureTab = "live" | "upload";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const stripSpeakerPrefix = (text: string) => text.replace(/^\[.*?\]\s*/, "");

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

  const [segments, setSegments] = useState<Segment[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [showPlayback, setShowPlayback] = useState(false);

  const [showFinishModal, setShowFinishModal] = useState(false);
  const [showNewConvoModal, setShowNewConvoModal] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  const { start, pause, resume, finishAndUpload, cancel } = useAzureSpeech({
    onPartial: handleAzurePartial,
    onFinal: handleAzureFinal,
    onError: handleAzureError,
  });

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

  const clearPlayback = useCallback(() => {
    setSegments([]);
    setShowPlayback(false);
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const handleStart = useCallback(async () => {
    sessionIdRef.current += 1;
    clearPlayback();
    setLines([]);
    setInterim("");
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
    setStatusMessage("Finalizing & diarizing...");
    try {
      const result = await finishAndUpload();
      if (sid !== sessionIdRef.current) return;
      if (result?.audioUrl) {
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return result.audioUrl;
        });
      }
      if (Array.isArray(result?.segments) && result.segments.length > 0) {
        setSegments(result.segments as Segment[]);
        setLines(
          result.segments.map(
            (s: any) => `${s.speaker}: ${stripSpeakerPrefix(s.text)}`,
          ),
        );
        setInterim("");
        setShowPlayback(true);
      }
      setStatusMessage(
        result?.status === "success" ? "Playback ready" : "Recording finished",
      );
    } catch (e: any) {
      if (sid !== sessionIdRef.current) return;
      setStatusMessage(`⚠️ ${e?.message || "Finish failed"}`);
    }
  }, [finishAndUpload, stopLiveEvents]);

  const handleProcessUpload = useCallback(async () => {
    if (!uploadFile) return;
    const sid = sessionIdRef.current;
    clearPlayback();
    setLines([]);
    setInterim("");
    setIsUploading(true);
    setUploadProgress(2);
    setStatusMessage("Preparing report...");

    const safeName = encodeURIComponent(uploadFile.name);
    const progressInterval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/progress/${safeName}`);
        const data = await res.json();
        if (data.total > 0) {
          setUploadProgress(Math.round((data.current / data.total) * 95));
        }
      } catch {}
    }, 2000);

    const form = new FormData();
    form.append("file", uploadFile);
    form.append("meeting_type", "Desktop Upload");

    try {
      const res = await fetch(`${API_URL}/transcribe`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      clearInterval(progressInterval);
      if (sid !== sessionIdRef.current) return;
      setUploadProgress(100);
      setTimeout(() => {
        if (sid !== sessionIdRef.current) return;
        setIsUploading(false);
        setUploadProgress(0);
        if (data.status === "success") {
          setLines([data.transcript]);
          setStatusMessage("Analysis ready!");
          setActiveTab("live");
        } else {
          setStatusMessage("Failed to process file.");
        }
      }, 400);
    } catch {
      clearInterval(progressInterval);
      if (sid !== sessionIdRef.current) return;
      setIsUploading(false);
      setUploadProgress(0);
      setStatusMessage("Connection failed.");
    }
  }, [uploadFile, clearPlayback]);

  const handleSaveTranscript = useCallback(async () => {
    if (!transcriptText.trim() && segments.length === 0) return;
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
        segments.length > 0
          ? segments.map((s) => ({
              speaker: s.speaker,
              text: stripSpeakerPrefix(s.text),
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
  }, [transcriptText, segments, lines]);

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
    if (isRecording || lines.length > 0 || segments.length > 0) {
      setShowNewConvoModal(true);
    } else {
      doReset();
    }
  }, [isRecording, lines.length, segments.length, doReset]);

  const handleLogout = useCallback(() => {
    stopLiveEvents();
    if (isRecording) cancel();
    clearSession();
    router.push("/auth");
  }, [isRecording, cancel, router, stopLiveEvents]);

  const handleDeleteAccount = useCallback(async () => {
    setDeleting(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/delete-account`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to delete account");
      }
      stopLiveEvents();
      if (isRecording) cancel();
      clearMeetings();
      clearSession();
      router.replace("/auth");
    } catch (e: any) {
      setDeleting(false);
      setShowDeleteModal(false);
      setStatusMessage(`⚠️ ${e?.message || "Delete failed"}`);
    }
  }, [isRecording, cancel, router, stopLiveEvents]);

  const handleTranscriptEdit = useCallback((text: string) => {
    setLines(text ? [text] : []);
    setInterim("");
    setSegments([]);
    setShowPlayback(false);
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
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <TranscriptArea
                  transcriptText={transcriptText}
                  segments={segments}
                  audioUrl={audioUrl}
                  showPlayback={showPlayback}
                  editable={!isRecording}
                  onSave={handleSaveTranscript}
                  onTranscriptEdit={handleTranscriptEdit}
                />
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
              onClick={() => setShowFinishModal(true)}
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
            <h3 className="text-xl font-bold text-slate-900">Finish recording?</h3>
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
        title="Delete account?"
        message="Are you sure you want to permanently delete your account? This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDeleteAccount}
        onCancel={() => setShowDeleteModal(false)}
      />
    </div>
  );
}
