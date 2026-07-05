"use client";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
  Check,
  Upload,
  Menu,
  FileText,
  Highlighter,
} from "lucide-react";
import { useGlobalRecording } from "@/components/GlobalRecordingProvider";
import MyMeetings from "@/components/MyMeetings";
import Sidebar, { type DashboardView } from "./Sidebar";
import MobileSidebar from "./MobileSidebar";
import CaptureControls from "./CaptureControls";
import TranscriptArea from "./TranscriptArea";
import {
  loadMeetings,
  addMeeting,
  updateMeeting,
  MEETINGS_EVENT,
} from "@/lib/meetingStore";
import { getUserName, clearSession } from "@/lib/auth";
import { diarizeAudioFile } from "@/lib/diarize";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ScrollNav from "@/components/ui/ScrollNav";
import AudioPlayer from "@/components/ui/AudioPlayer";
import HighlightedText, {
  highlightRanges,
} from "@/components/ui/HighlightedText";

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

// Brand palette only: Teal, Ocean Blue, Navy, Optima Aqua. Each speaker's
// label text and left border share the same colour.
const SPEAKER_HEX = [
  "#2FB5AA", // Teal
  "#2E6DBE", // Ocean Blue
  "#1F2540", // Navy
  "#3B96A9", // Optima Aqua
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
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_35%_at_18%_12%,rgba(47,181,170,0.12),transparent_60%),radial-gradient(45%_40%_at_85%_88%,rgba(46,109,190,0.10),transparent_60%)]"
    />
  );
}

export default function Dashboard() {
  const router = useRouter();

  const [view, setView] = useState<DashboardView>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const [diarizeProgress, setDiarizeProgress] = useState(0);
  // Phase 2: which view of a finished recording is shown, the source audio for
  // retry, and the retry modal shown when diarization fails.
  const [transcriptView, setTranscriptView] = useState<"transcript" | "diarize">(
    "transcript",
  );
  const [audioFilePath, setAudioFilePath] = useState<string | null>(null);
  const [showDiarizeRetryModal, setShowDiarizeRetryModal] = useState(false);
  // Once this session is saved to MyMeetings, remember its id so that if it gets
  // diarized elsewhere (e.g. from MyMeetings) we can reuse that result here
  // instead of hitting the diarize API again.
  const [savedMeetingId, setSavedMeetingId] = useState<string | null>(null);
  // Manual text highlights (phrases) + whether they're shown + the floating
  // "Highlight" button anchored to the current selection.
  const [highlights, setHighlights] = useState<string[]>([]);
  const [showHighlights, setShowHighlights] = useState(true);
  // When on, the transcript shows ONLY the highlighted snippets.
  const [highlightsOnly, setHighlightsOnly] = useState(false);
  // Inline speaker rename: which diarized row's label is being edited + draft.
  const [editingSpeakerIdx, setEditingSpeakerIdx] = useState<number | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState("");
  const [hlButton, setHlButton] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [currentAudioTime, setCurrentAudioTime] = useState(0);
  const [mergedEditMode, setMergedEditMode] = useState(false);
  const [mergedDraft, setMergedDraft] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  const [showFinishModal, setShowFinishModal] = useState(false);
  // Meeting setup form (title + duration), the running meeting's title/target,
  // and the "5 minutes left — extend?" reminder.
  const [showStartForm, setShowStartForm] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formHours, setFormHours] = useState("1");
  const [formMinutes, setFormMinutes] = useState("0");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingDurationSec, setMeetingDurationSec] = useState(0);
  const [showExtendReminder, setShowExtendReminder] = useState(false);
  const [extendMinutes, setExtendMinutes] = useState("15");
  const reminderShownRef = useRef(false);
  const autoFinishingRef = useRef(false);
  const [showNewConvoModal, setShowNewConvoModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
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
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const hasUnsavedRef = useRef(false);

  const stopSmoothProgress = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const startSmoothProgress = useCallback(
    (audioDurationSec: number) => {
      stopSmoothProgress();
      setDiarizeProgress(2);
      const estMs = Math.max(8000, audioDurationSec * 1000 * 0.5);
      const startT = Date.now();
      progressTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - startT;
        const pct = Math.min(92, 2 + (elapsed / estMs) * 90);
        setDiarizeProgress((p) => (pct > p ? pct : p));
      }, 200);
    },
    [stopSmoothProgress],
  );

  const handleDiarizeProgress = useCallback((done: number, total: number) => {
    if (total <= 0) return;
    const floor = Math.min(96, (done / total) * 100);
    setDiarizeProgress((p) => (floor > p ? floor : p));
  }, []);

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
    finishRecording,
    getRecordingFilePath,
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
      onProgress: handleDiarizeProgress,
    });
  }, [
    handleAzurePartial,
    handleAzureFinal,
    handleAzureError,
    handleDiarizeProgress,
    setCallbacks,
  ]);

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

  const activeWordStart = useMemo(() => {
    for (const seg of mergedTranscript) {
      const ws = seg.words;
      if (!ws) continue;
      for (const w of ws) {
        if (currentAudioTime >= w.start && currentAudioTime < w.end) {
          return w.start;
        }
      }
    }
    return null;
  }, [mergedTranscript, currentAudioTime]);

  useEffect(() => {
    if (activeWordStart == null) return;
    activeWordRef.current?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [activeWordStart]);

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

  useEffect(() => {
    hasUnsavedRef.current =
      isRecording ||
      isDiarizing ||
      isUploading ||
      ((mergedTranscript.length > 0 || lines.length > 0) && !isSaved);
  }, [
    isRecording,
    isDiarizing,
    isUploading,
    mergedTranscript.length,
    lines.length,
    isSaved,
  ]);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.onCloseRequested) return;
    return api.onCloseRequested(() => {
      if (hasUnsavedRef.current) setShowCloseModal(true);
      else api.confirmClose?.();
    });
  }, []);

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

  const speakerHex = useMemo(() => {
    const map: Record<string, string> = {};
    mergedTranscript.forEach((r) => {
      if (!(r.speaker in map)) {
        map[r.speaker] = SPEAKER_HEX[Object.keys(map).length % SPEAKER_HEX.length];
      }
    });
    return map;
  }, [mergedTranscript]);

  // A diarized row "has a highlight" if any highlighted phrase falls inside it.
  // Used by the highlights-only view to show the full speaker box, not just the
  // clipped phrase.
  const rowHasHighlight = (item: MergedTranscriptRow) => {
    if (!highlights.length) return false;
    const rowText = item.words?.length
      ? item.words.map((w) => w.word).join(" ")
      : stripSpeakerPrefix(item.text);
    return highlightRanges(rowText, highlights).length > 0;
  };

  // Rename a speaker everywhere in the transcript (e.g. "Speaker 1" -> "Shaurya").
  const commitSpeakerRename = (origSpeaker: string) => {
    const name = speakerDraft.trim();
    setEditingSpeakerIdx(null);
    if (!name || name === origSpeaker) return;
    setMergedTranscript((rows) =>
      rows.map((r) => (r.speaker === origSpeaker ? { ...r, speaker: name } : r)),
    );
  };

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
    setIsSaved(false);
    setAudioFilePath(null);
    setSavedMeetingId(null);
    setTranscriptView("diarize");
    setHighlights([]);
    setHighlightsOnly(false);
    setHlButton(null);
    setStatusMessage(null);
    reminderShownRef.current = false;
    autoFinishingRef.current = false;
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

  // Meeting setup form → set title + target duration, then start recording.
  const submitStartForm = useCallback(() => {
    const h = Math.max(0, parseInt(formHours || "0", 10) || 0);
    const m = Math.max(0, parseInt(formMinutes || "0", 10) || 0);
    const totalSec = (h * 60 + m) * 60;
    if (totalSec <= 0) return; // require a duration
    setMeetingTitle(formTitle.trim());
    setMeetingDurationSec(totalSec);
    reminderShownRef.current = false;
    autoFinishingRef.current = false;
    setShowStartForm(false);
    void handleStart();
  }, [formHours, formMinutes, formTitle, handleStart]);

  // Extend the running meeting by N minutes (re-arms the 5-min reminder).
  const submitExtend = useCallback(() => {
    const add = Math.max(0, parseInt(extendMinutes || "0", 10) || 0);
    setShowExtendReminder(false);
    if (add <= 0) return;
    setMeetingDurationSec((d) => d + add * 60);
    reminderShownRef.current = false;
    autoFinishingRef.current = false;
    setStatusMessage(`Meeting extended by ${add} min`);
  }, [extendMinutes]);

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

  // Floating recorder widget: tell the main process when recording is active
  // (so it can show/hide the always-on-top window on minimize) and stream the
  // current timer + paused state to it.
  useEffect(() => {
    window.electronAPI?.recorderSetActive?.(isRecording);
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording) return;
    window.electronAPI?.recorderSetState?.({
      timeText: formatTime(sessionTime),
      isPaused,
    });
  }, [isRecording, sessionTime, isPaused]);

  // Pause / Resume / Stop coming from the floating widget.
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.onRecorderAction) return;
    return api.onRecorderAction((action) => {
      if (action === "pause") handlePause();
      else if (action === "resume") handleResume();
      else if (action === "stop") {
        setView("dashboard");
        setShowFinishModal(true);
      }
    });
  }, [handlePause, handleResume]);

  // Silently save the finished meeting to MyMeetings + a local backup file named
  // by the meeting title. No save dialog. Diarization is done later (MyMeetings).
  const autoSaveMeeting = useCallback(
    (audioMediaUrl: string | null, audioPath: string | null) => {
      const hasContent = transcriptText.trim() || lines.length > 0;
      if (!hasContent) return;
      const firstWords =
        lines[0]?.split(" ").slice(0, 5).join(" ") || "Discussion";
      const title = meetingTitle.trim() || `Meeting on ${firstWords}`;
      const entries = lines.map((l) => ({
        speaker: "Speaker",
        text: l,
        timestamp: "",
      }));
      const record = {
        id: Date.now().toString(),
        topic: title,
        date: new Date().toISOString(),
        transcript: entries,
        durationSec: sessionTime,
        plainText: transcriptText,
        diarized: undefined,
        audioPath: audioPath || undefined,
        audioMediaUrl:
          audioMediaUrl && audioMediaUrl.startsWith("media://")
            ? audioMediaUrl
            : undefined,
      };
      addMeeting(record);
      setSavedMeetingId(record.id);
      setIsSaved(true);
      // Silent PC backup, named by the meeting title.
      void window.electronAPI?.saveTranscriptLocal?.(
        transcriptText,
        title,
        "txt",
      );
      setStatusMessage(`✅ Saved as "${title}" — diarize it in MyMeetings.`);
    },
    [meetingTitle, transcriptText, lines, sessionTime],
  );

  const confirmFinish = useCallback(async () => {
    const sid = sessionIdRef.current;
    stopLiveEvents();
    setShowFinishModal(false);
    setShowExtendReminder(false);
    setIsRecording(false);
    setIsPaused(false);
    setInterim("");
    setTranscriptView("transcript");
    setMergedTranscript([]);
    setStatusMessage("Finishing recording...");
    try {
      const result = await finishRecording();
      if (sid !== sessionIdRef.current) return;
      const finalAudioUrl = result?.audioUrl || null;
      const finalAudioPath =
        result?.audioFilePath || getRecordingFilePath() || null;
      if (finalAudioUrl) {
        setCurrentAudioTime(0);
        setAudioUrl((prev) => {
          if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
          return finalAudioUrl;
        });
      }
      if (finalAudioPath) setAudioFilePath(finalAudioPath);
      // Auto-save the meeting (title-named) — both on manual Finish and timeout.
      autoSaveMeeting(finalAudioUrl, finalAudioPath);
    } catch (e: any) {
      if (sid !== sessionIdRef.current) return;
      const path = getRecordingFilePath();
      if (path) setAudioFilePath(path);
      setStatusMessage("⚠️ Could not finalize the recording");
    }
  }, [finishRecording, getRecordingFilePath, stopLiveEvents, autoSaveMeeting]);

  // Duration watchdog: 5-min "extend?" reminder, then auto-finish + save at the
  // target time. Short meetings (<= 5 min) skip the reminder.
  useEffect(() => {
    if (!isRecording || meetingDurationSec <= 0) return;
    const remaining = meetingDurationSec - sessionTime;
    if (remaining <= 0) {
      if (autoFinishingRef.current) return;
      autoFinishingRef.current = true;
      void confirmFinish();
      return;
    }
    if (
      meetingDurationSec > 300 &&
      remaining <= 300 &&
      !reminderShownRef.current
    ) {
      reminderShownRef.current = true;
      setShowExtendReminder(true);
    }
  }, [sessionTime, meetingDurationSec, isRecording, confirmFinish]);

  // Diarize the finalized recording ON DEMAND (triggered by the Diarize button
  // and by the retry modal). Only runs when not already diarized, so the API is
  // hit exactly once — clicking the toggle afterwards just switches views.
  const handleDiarizeRetry = useCallback(async () => {
    if (!audioFilePath || isDiarizing || mergedTranscript.length > 0) {
      setShowDiarizeRetryModal(false);
      return;
    }
    const sid = sessionIdRef.current;
    setShowDiarizeRetryModal(false);

    // If this session was already diarized elsewhere (e.g. in MyMeetings after
    // saving), reuse that stored result instead of hitting the API again.
    if (savedMeetingId) {
      const saved = loadMeetings().find((m) => m.id === savedMeetingId);
      if (saved?.diarized && saved.diarized.length > 0) {
        const rows = saved.diarized.map((r) => ({
          speaker: r.speaker,
          text: r.text,
          start: r.start ?? 0,
          end: r.end ?? 0,
          words: r.words,
        })) as MergedTranscriptRow[];
        setMergedTranscript(rows);
        setTranscriptView("diarize");
        setIsSaved(true);
        setStatusMessage("Loaded speakers from your saved meeting.");
        return;
      }
    }

    setIsDiarizing(true);
    setDiarizeProgress(2);
    setStatusMessage("Separating speakers...");
    startSmoothProgress(sessionTime);
    try {
      const rows = (await diarizeAudioFile(audioFilePath, {
        jwt: localStorage.getItem("token"),
        onProgress: handleDiarizeProgress,
      })) as MergedTranscriptRow[];
      if (sid !== sessionIdRef.current) return;
      stopSmoothProgress();
      setDiarizeProgress(100);
      setMergedTranscript(rows);
      setTranscriptView("diarize");
      setIsSaved(false);
      void saveTranscriptLocally(rows);
      setStatusMessage("Speakers separated — click Save to keep it.");
    } catch (e: any) {
      stopSmoothProgress();
      if (sid !== sessionIdRef.current) return;
      setDiarizeProgress(0);
      setStatusMessage("⚠️ Diarization failed");
      setShowDiarizeRetryModal(true);
    } finally {
      stopSmoothProgress();
      if (sid === sessionIdRef.current) setIsDiarizing(false);
    }
  }, [
    audioFilePath,
    isDiarizing,
    mergedTranscript.length,
    savedMeetingId,
    sessionTime,
    startSmoothProgress,
    stopSmoothProgress,
    handleDiarizeProgress,
    saveTranscriptLocally,
  ]);

  const handleProcessUpload = useCallback(async () => {
    if (!uploadFile) return;
    const sid = sessionIdRef.current;
    clearPlayback();
    setLines([]);
    setInterim("");
    setMergedTranscript([]);
    setIsSaved(false);
    setIsUploading(true);
    setUploadProgress(2);

    const abort = new AbortController();
    uploadAbortRef.current = abort;

    const token = localStorage.getItem("token");
    const electron =
      typeof window !== "undefined" ? window.electronAPI : undefined;
    const localPath = electron?.getPathForFile?.(uploadFile) || "";
    // Remember the source file so an uploaded meeting can be re-diarized later.
    setAudioFilePath(localPath || null);

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
          // Uploads have no plain live transcript — show the diarized view.
          setTranscriptView("diarize");
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
            signal: abort.signal,
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
        signal: abort.signal,
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
      if (e?.name === "AbortError" || sid !== sessionIdRef.current) return;
      setIsUploading(false);
      setUploadProgress(0);
      setStatusMessage(e?.message || "Could not process the file.");
    } finally {
      if (uploadAbortRef.current === abort) uploadAbortRef.current = null;
    }
  }, [uploadFile, clearPlayback, saveTranscriptLocally]);

  const handleSaveTranscript = useCallback(async () => {
    if (!transcriptText.trim() && mergedTranscript.length === 0) return;
    // Save the file matching the current view: diarized rows on the Diarize
    // view, plain text on the Transcript view. MyMeetings always keeps both.
    const kind = transcriptView === "diarize" ? "Diarized" : "Transcript";
    const defaultName = `ThreadNotes_${kind}_${new Date().toISOString().slice(0, 10)}.txt`;

    let savedFilePath: string | undefined;
    let savedName: string | undefined;

    try {
      if (typeof window !== "undefined" && window.electronAPI?.exportTranscript) {
        const exportRows = mergedTranscript.map((item) => ({
          speaker: item.speaker,
          text: stripSpeakerPrefix(item.text),
        }));
        const result = await window.electronAPI.exportTranscript({
          plainText: transcriptText,
          diarized: exportRows,
          view: transcriptView,
          defaultName,
        });
        if (!result.saved) {
          setStatusMessage("Ready");
          return;
        }
        savedFilePath = result.filePath;
        if (savedFilePath) {
          savedName = savedFilePath
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.[^.]+$/, "");
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
      const durationSec =
        mergedTranscript.length > 0
          ? Math.round(
              Math.max(0, ...mergedTranscript.map((r) => Number(r.end) || 0)),
            )
          : sessionTime;
      const diarized =
        mergedTranscript.length > 0
          ? mergedTranscript.map((item) => ({
              speaker: item.speaker,
              text: stripSpeakerPrefix(item.text),
              start: item.start,
              end: item.end,
              words: item.words,
            }))
          : undefined;
      // Fall back to the live recorder's file path so saving BEFORE diarization
      // finishes still captures the audio (enables re-diarize later).
      const recordedPath = audioFilePath || getRecordingFilePath();
      const record = {
        id: Date.now().toString(),
        topic: savedName || `Meeting on ${firstWords}`,
        date: new Date().toISOString(),
        transcript: entries,
        filePath: savedFilePath,
        durationSec,
        plainText: transcriptText,
        diarized,
        audioPath: recordedPath || undefined,
        audioMediaUrl:
          audioUrl && audioUrl.startsWith("media://") ? audioUrl : undefined,
        highlights: highlights.length ? highlights : undefined,
        highlightsShown: showHighlights,
      };
      // If this session was already saved (auto-save on finish), update that
      // meeting instead of creating a duplicate — e.g. after diarizing here.
      if (savedMeetingId) {
        updateMeeting(savedMeetingId, {
          durationSec: record.durationSec,
          plainText: record.plainText,
          diarized: record.diarized,
          audioPath: record.audioPath,
          audioMediaUrl: record.audioMediaUrl,
          highlights: record.highlights,
          highlightsShown: record.highlightsShown,
        });
      } else {
        addMeeting(record);
        setSavedMeetingId(record.id);
      }
      setIsSaved(true);
      setStatusMessage("✅ Saved!");
    } catch {
      setStatusMessage("⚠️ Save failed");
    }
  }, [
    transcriptText,
    mergedTranscript,
    transcriptView,
    lines,
    sessionTime,
    audioFilePath,
    audioUrl,
    highlights,
    showHighlights,
    savedMeetingId,
    getRecordingFilePath,
  ]);

  // Ctrl/Cmd+S opens the save dialog once diarization has produced a transcript.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        if (mergedTranscript.length > 0 && !isDiarizing) {
          e.preventDefault();
          void handleSaveTranscript();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mergedTranscript.length, isDiarizing, handleSaveTranscript]);

  const doReset = useCallback(() => {
    sessionIdRef.current += 1;
    stopLiveEvents();
    cancel();
    if (uploadAbortRef.current) {
      try {
        uploadAbortRef.current.abort();
      } catch {}
      uploadAbortRef.current = null;
    }
    stopSmoothProgress();
    clearPlayback();
    setIsRecording(false);
    setIsPaused(false);
    setIsDiarizing(false);
    setDiarizeProgress(0);
    setIsUploading(false);
    setUploadProgress(0);
    setSessionTime(0);
    setLines([]);
    setInterim("");
    setMergedTranscript([]);
    setUploadFile(null);
    setStatusMessage(null);
    setIsSaved(false);
    setAudioFilePath(null);
    setSavedMeetingId(null);
    setTranscriptView("diarize");
    setHighlights([]);
    setHighlightsOnly(false);
    setHlButton(null);
    setShowDiarizeRetryModal(false);
    setMeetingDurationSec(0);
    setMeetingTitle("");
    setShowExtendReminder(false);
    reminderShownRef.current = false;
    autoFinishingRef.current = false;
    setActiveTab("live");
    setView("dashboard");
  }, [cancel, clearPlayback, stopLiveEvents, stopSmoothProgress]);

  const handleNewConversationClick = useCallback(() => {
    if (
      isRecording ||
      isDiarizing ||
      isUploading ||
      lines.length > 0 ||
      mergedTranscript.length > 0
    ) {
      setShowNewConvoModal(true);
    } else {
      doReset();
    }
  }, [
    isRecording,
    isDiarizing,
    isUploading,
    lines.length,
    mergedTranscript.length,
    doReset,
  ]);

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
      stopLiveEvents();
      if (isRecording) cancel();
      localStorage.clear();
      router.replace("/auth");
    } catch (e: any) {
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

  // Show a floating "Highlight" button anchored to the current text selection.
  const handleTranscriptMouseUp = useCallback(() => {
    // Highlighting is a diarize-only feature.
    if (transcriptView !== "diarize") {
      setHlButton(null);
      return;
    }
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    const text = sel?.toString().trim() ?? "";
    if (!sel || sel.rangeCount === 0 || text.length < 2) {
      setHlButton(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setHlButton({ x: rect.left + rect.width / 2, y: rect.top, text });
  }, [transcriptView]);

  const isHighlighted = useCallback(
    (text: string) =>
      highlights.some(
        (h) => h === text || h.includes(text) || text.includes(h),
      ),
    [highlights],
  );

  const addHighlight = useCallback(() => {
    const text = hlButton?.text;
    if (!text) return;
    setHighlights((prev) => {
      const already = prev.some(
        (h) => h === text || h.includes(text) || text.includes(h),
      );
      // Selecting already-highlighted text un-highlights it.
      return already
        ? prev.filter(
            (h) => !(h === text || h.includes(text) || text.includes(h)),
          )
        : [...prev, text];
    });
    setShowHighlights(true);
    setHlButton(null);
    window.getSelection?.()?.removeAllRanges();
  }, [hlButton]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50 text-slate-800">
      <Sidebar
        className="hidden w-64 lg:flex"
        activeView={view}
        onNavigate={setView}
        meetingsCount={meetingsCount}
        userName={userName}
        onLogout={() => setShowLogoutModal(true)}
        onDeleteAccount={() => setShowDeleteModal(true)}
      />

      <MobileSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeView={view}
        onNavigate={setView}
        meetingsCount={meetingsCount}
        userName={userName}
        onLogout={() => setShowLogoutModal(true)}
        onDeleteAccount={() => setShowDeleteModal(true)}
      />

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <AmbientGlow />

        <header className="relative z-20 flex shrink-0 items-center gap-3 border-b border-white/60 bg-white/50 px-4 py-3 backdrop-blur-xl lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-600 transition-colors hover:bg-white/70 hover:text-slate-900"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="flex items-center gap-2 text-base font-bold tracking-tight text-slate-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-violet-500 to-blue-500 shadow-sm shadow-violet-500/30">
              <FileText className="h-4 w-4 text-white" strokeWidth={2.2} />
            </span>
            ThreadNotes
          </span>
        </header>

        {view === "dashboard" ? (
          <div className="custom-scrollbar relative z-10 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 lg:gap-4 lg:py-4">
            <div className="flex shrink-0 flex-wrap items-end justify-between gap-4 lg:mt-4">
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

            <div className="flex w-full flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row">
              <div className="flex min-h-[22rem] w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto lg:h-full lg:min-h-0 lg:w-1/2">
                <CaptureControls
                  isRecording={isRecording}
                  isPaused={isPaused}
                  sessionTime={sessionTime}
                  activeTab={activeTab}
                  systemStatus={systemStatus}
                  isDiarizing={isDiarizing}
                  diarizeProgress={diarizeProgress}
                  isCompleted={
                    !isRecording &&
                    !isDiarizing &&
                    !isUploading &&
                    (!!audioUrl ||
                      lines.length > 0 ||
                      mergedTranscript.length > 0)
                  }
                  onStart={() => {
                    setFormTitle("");
                    setFormHours("1");
                    setFormMinutes("0");
                    setShowStartForm(true);
                  }}
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
              <div className="flex min-h-[22rem] w-full min-w-0 flex-col lg:h-full lg:min-h-0 lg:w-1/2">
                {mergedTranscript.length > 0 || audioUrl ? (
                  <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/60 bg-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.06)] backdrop-blur-xl">
                    <div className="flex items-center justify-between bg-linear-to-r from-violet-500 to-blue-500 px-6 py-4">
                      <h3 className="text-base font-bold text-white">
                        Playback &amp; Transcript
                      </h3>
                      <div className="flex items-center gap-2">
                        {transcriptView === "diarize" && (
                          <button
                            onClick={() => setHighlightsOnly((v) => !v)}
                            aria-label={
                              highlightsOnly
                                ? "Show full transcript"
                                : "Show only highlights"
                            }
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg ring-1 ring-white/30 transition-colors ${
                              highlightsOnly
                                ? "bg-white text-[#2E6DBE]"
                                : "bg-white/20 text-white hover:bg-white/30"
                            }`}
                          >
                            <Highlighter className="h-4 w-4" />
                            <span className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover:block">
                              {highlightsOnly ? "Show all" : "Only highlights"}
                            </span>
                          </button>
                        )}
                        <button
                          onClick={toggleMergedEdit}
                          aria-label={mergedEditMode ? "Done" : "Edit"}
                          className="group relative flex h-9 w-9 items-center justify-center rounded-lg bg-white/20 text-white ring-1 ring-white/30 transition-colors hover:bg-white/30"
                        >
                          {mergedEditMode ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Pencil className="h-4 w-4" />
                          )}
                          <span className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover:block">
                            {mergedEditMode ? "Done" : "Edit"}
                          </span>
                        </button>
                        <button
                          onClick={handleSaveTranscript}
                          disabled={mergedEditMode}
                          aria-label="Save"
                          className="group relative flex h-9 w-9 items-center justify-center rounded-lg bg-white/20 text-white ring-1 ring-white/30 transition-colors hover:bg-white/30 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Upload className="h-4 w-4" />
                          <span className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover:block">
                            Save
                          </span>
                        </button>
                      </div>
                    </div>

                    {audioUrl && !mergedEditMode && (
                      <div className="shrink-0 border-b border-white/60 bg-white/40 px-6 py-4">
                        <AudioPlayer
                          src={audioUrl}
                          audioRef={audioRef}
                          onTimeUpdate={setCurrentAudioTime}
                        />
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <p className="bg-linear-to-r from-indigo-500 to-blue-500 bg-clip-text text-[11px] font-semibold uppercase tracking-widest text-transparent">
                            Play to highlight the transcript in sync
                          </p>
                          {mergedTranscript.length === 0 ? (
                            <button
                              onClick={handleDiarizeRetry}
                              disabled={isDiarizing || !audioFilePath}
                              className="shrink-0 rounded-full bg-slate-100 px-4 py-1 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-70"
                            >
                              {isDiarizing ? "Diarizing…" : "Diarize"}
                            </button>
                          ) : (
                            <button
                              onClick={() =>
                                setTranscriptView((v) =>
                                  v === "diarize" ? "transcript" : "diarize",
                                )
                              }
                              className="shrink-0 rounded-full bg-slate-100 px-4 py-1 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-200"
                            >
                              {transcriptView === "diarize"
                                ? "Diarize"
                                : "Transcript"}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    <div
                      ref={transcriptScrollRef}
                      onMouseUp={handleTranscriptMouseUp}
                      onScroll={() => setHlButton(null)}
                      className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-6"
                    >
                      {highlightsOnly && highlights.length === 0 ? (
                        <p className="text-sm text-slate-400">
                          No highlights yet — select text and click Highlight.
                        </p>
                      ) : !highlightsOnly && transcriptView === "transcript" ? (
                        <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">
                          {transcriptText ? (
                            // Highlights are created in the Diarize view; mirror
                            // the same highlighted phrases here in Transcript.
                            <HighlightedText
                              text={transcriptText}
                              phrases={highlights}
                              enabled={showHighlights}
                            />
                          ) : (
                            "No transcript captured."
                          )}
                        </div>
                      ) : !highlightsOnly && mergedEditMode ? (
                        <textarea
                          value={mergedDraft}
                          onChange={(e) => setMergedDraft(e.target.value)}
                          placeholder="Edit the transcript..."
                          className="h-full min-h-[300px] w-full resize-none rounded-xl border border-slate-200 bg-white/80 p-4 text-[15px] leading-relaxed text-slate-700 outline-none focus:ring-2 focus:ring-violet-500/40"
                        />
                      ) : (
                        <div className="space-y-3">
                          {(highlightsOnly
                            ? mergedTranscript.filter(rowHasHighlight)
                            : mergedTranscript
                          ).map((item, index) => {
                            const speakerLine =
                              speakerHex[item.speaker] || "#94A3B8";
                            const words = item.words ?? [];
                            const rowText = words.map((w) => w.word).join(" ");
                            const hlRanges =
                              showHighlights && highlights.length && words.length
                                ? highlightRanges(rowText, highlights)
                                : [];
                            const wordStarts: number[] = [];
                            let acc = 0;
                            for (const w of words) {
                              wordStarts.push(acc);
                              acc += w.word.length + 1;
                            }

                            return (
                              <div
                                key={`${item.speaker}-${item.start}-${index}`}
                                className="rounded-xl border border-l-4 border-white/40 bg-white/40 px-4 py-3"
                                style={{ borderLeftColor: speakerLine }}
                              >
                                <div className="mb-1 flex items-center gap-3">
                                  {editingSpeakerIdx === index ? (
                                    <input
                                      autoFocus
                                      value={speakerDraft}
                                      onChange={(e) =>
                                        setSpeakerDraft(e.target.value)
                                      }
                                      onBlur={() =>
                                        commitSpeakerRename(item.speaker)
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                          commitSpeakerRename(item.speaker);
                                        if (e.key === "Escape")
                                          setEditingSpeakerIdx(null);
                                      }}
                                      className="w-36 rounded border border-slate-300 bg-white px-2 py-0.5 text-sm font-bold outline-none focus:ring-2 focus:ring-violet-500/40"
                                      style={{ color: speakerLine }}
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingSpeakerIdx(index);
                                        setSpeakerDraft(item.speaker);
                                      }}
                                      title="Click to rename this speaker everywhere"
                                      className="text-sm font-bold hover:underline"
                                      style={{ color: speakerLine }}
                                    >
                                      {item.speaker}
                                    </button>
                                  )}
                                </div>
                                <p className="text-[15px] leading-relaxed text-slate-700">
                                  {words.length > 0
                                    ? words.map((w, wi) => {
                                        const isActive =
                                          currentAudioTime >= w.start &&
                                          currentAudioTime < w.end;
                                        const wStart = wordStarts[wi];
                                        const wEnd = wStart + w.word.length;
                                        const isHl = hlRanges.some(
                                          ([s, e]) => wStart < e && wEnd > s,
                                        );
                                        return (
                                          <span
                                            key={wi}
                                            ref={
                                              isActive ? activeWordRef : null
                                            }
                                            className={
                                              isActive
                                                ? "rounded-md bg-indigo-100 px-1 py-0.5 font-bold text-indigo-700 shadow-sm ring-1 ring-indigo-200 transition-all duration-150"
                                                : isHl
                                                  ? "rounded bg-amber-200/70 px-0.5 transition-all duration-150"
                                                  : "transition-all duration-150"
                                            }
                                          >
                                            {w.word}{" "}
                                          </span>
                                        );
                                      })
                                    : (
                                        <HighlightedText
                                          text={stripSpeakerPrefix(item.text)}
                                          phrases={highlights}
                                          enabled={showHighlights}
                                        />
                                      )}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <ScrollNav targetRef={transcriptScrollRef} />
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

      {showStartForm && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">New meeting</h3>
            <p className="mt-1 text-sm text-slate-500">
              Give it a title and set how long it should run.
            </p>

            <label className="mt-5 block text-xs font-bold uppercase tracking-wide text-slate-500">
              Meeting title
            </label>
            <input
              autoFocus
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              placeholder="e.g. Product sync"
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-violet-500/40"
            />

            <label className="mt-4 block text-xs font-bold uppercase tracking-wide text-slate-500">
              Duration
            </label>
            <div className="mt-1.5 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  value={formHours}
                  onChange={(e) => setFormHours(e.target.value)}
                  className="w-16 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-center text-sm text-slate-800 outline-none focus:ring-2 focus:ring-violet-500/40"
                />
                <span className="text-sm text-slate-500">hr</span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={formMinutes}
                  onChange={(e) => setFormMinutes(e.target.value)}
                  className="w-16 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-center text-sm text-slate-800 outline-none focus:ring-2 focus:ring-violet-500/40"
                />
                <span className="text-sm text-slate-500">min</span>
              </div>
            </div>

            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowStartForm(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={submitStartForm}
                className="flex-1 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600"
              >
                Start meeting
              </button>
            </div>
          </div>
        </div>
      )}

      {showExtendReminder && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              5 minutes left
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              Your meeting is about to end. Want to extend the duration?
            </p>
            <div className="mt-4 flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={extendMinutes}
                onChange={(e) => setExtendMinutes(e.target.value)}
                className="w-20 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-center text-sm text-slate-800 outline-none focus:ring-2 focus:ring-violet-500/40"
              />
              <span className="text-sm text-slate-500">more minutes</span>
            </div>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowExtendReminder(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                No, finish soon
              </button>
              <button
                onClick={submitExtend}
                className="flex-1 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600"
              >
                Extend
              </button>
            </div>
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
              We&apos;ll stop and save this meeting. You can diarize it anytime
              from MyMeetings.
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

      {showDiarizeRetryModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Diarization failed
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              We couldn&apos;t separate the speakers this time. Your transcript
              is safe — you can retry diarization on the same recording.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowDiarizeRetryModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Not now
              </button>
              <button
                onClick={handleDiarizeRetry}
                disabled={!audioFilePath}
                className="flex-1 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {showCloseModal && (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">Close ThreadNotes?</h3>
            <p className="mt-2 text-sm text-slate-500">
              You have unsaved work. If you close now, the current transcript
              will be lost. Are you sure?
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowCloseModal(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowCloseModal(false);
                  window.electronAPI?.confirmClose?.();
                }}
                className="flex-1 rounded-xl bg-linear-to-r from-rose-500 to-red-500 py-3 text-sm font-bold text-white shadow-lg shadow-red-500/25 transition-all hover:from-rose-600 hover:to-red-600"
              >
                Close anyway
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

      {hlButton && (
        <button
          onClick={addHighlight}
          style={{ left: hlButton.x, top: hlButton.y - 44 }}
          className="fixed z-200 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-xl"
        >
          <Highlighter className="h-3.5 w-3.5" />
          {isHighlighted(hlButton.text) ? "Unhighlight" : "Highlight"}
        </button>
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
