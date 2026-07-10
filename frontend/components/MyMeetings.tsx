"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import { Download, CalendarDays, Clock, Highlighter, Copy } from "lucide-react";
import HighlightedText, {
  highlightRanges,
} from "@/components/ui/HighlightedText";
import {
  loadMeetings,
  saveMeetings,
  updateMeeting,
  MEETINGS_EVENT,
} from "@/lib/meetingStore";
import { diarizeAudioFile } from "@/lib/diarize";
import AudioPlayer from "@/components/ui/AudioPlayer";

type TranscriptEntry = { speaker: string; text: string; timestamp: string };
type Meeting = {
  id: string;
  topic: string;
  date: string;
  transcript: TranscriptEntry[];
  filePath?: string;
  durationSec?: number;
  plainText?: string;
  diarized?: DiarizedRow[];
  audioPath?: string;
  audioMediaUrl?: string;
  highlights?: string[];
  highlightsShown?: boolean;
};

type DiarizedRow = {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
  words?: { word: string; start: number; end: number }[];
};

const SPEAKER_HEX = [
  "#2FB5AA",
  "#2E6DBE",
  "#1F2540",
  "#3B96A9",
];

function getDiarizedRows(m: Meeting): DiarizedRow[] | null {
  if (m.diarized && m.diarized.length > 0) return m.diarized;
  if (!m.plainText && m.transcript.length > 0) return m.transcript;
  return null;
}

function getPlainText(m: Meeting): string {
  // Prefer the diarized text (same wording as the Diarize view) so a highlight
  // made there mirrors exactly here. Fall back to plainText / legacy transcript.
  if (m.diarized && m.diarized.length > 0) {
    return m.diarized.map((r) => r.text).join("\n\n");
  }
  if (m.plainText) return m.plainText;
  return m.transcript.map((t) => t.text).join("\n\n");
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

export default function MyMeetings() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);

  const [meetingToDelete, setMeetingToDelete] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const [detailView, setDetailView] = useState<"transcript" | "diarize">(
    "diarize",
  );
  const [showDiarizeConfirm, setShowDiarizeConfirm] = useState(false);
  const [diarizing, setDiarizing] = useState(false);
  const [diarizeProgress, setDiarizeProgress] = useState(0);
  const [showDiarizeRetry, setShowDiarizeRetry] = useState(false);

  const [mtgHighlights, setMtgHighlights] = useState<string[]>([]);
  const [mtgShowHighlights, setMtgShowHighlights] = useState(true);
  const [mtgHighlightsOnly, setMtgHighlightsOnly] = useState(false);
  const [mtgAudioTime, setMtgAudioTime] = useState(0);
  const [mtgHlButton, setMtgHlButton] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  const [editingMtgSpeakerIdx, setEditingMtgSpeakerIdx] = useState<number | null>(
    null,
  );
  const [mtgSpeakerDraft, setMtgSpeakerDraft] = useState("");

  const searchInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mtgScrollRef = useRef<HTMLDivElement>(null);

  const commitMtgSpeakerRename = (origSpeaker: string) => {
    const name = mtgSpeakerDraft.trim();
    setEditingMtgSpeakerIdx(null);
    if (!name || name === origSpeaker || !selectedMeeting) return;
    const current = getDiarizedRows(selectedMeeting);
    if (!current) return;
    const updatedDiarized = current.map((r) =>
      r.speaker === origSpeaker ? { ...r, speaker: name } : r,
    );
    updateMeeting(selectedMeeting.id, { diarized: updatedDiarized });
    const updated = { ...selectedMeeting, diarized: updatedDiarized };
    setSelectedMeeting(updated);
    setMeetings((prev) =>
      prev.map((m) => (m.id === selectedMeeting.id ? updated : m)),
    );
  };

  useEffect(() => {
    const c = mtgScrollRef.current;
    if (!c) return;
    const el = c.querySelector<HTMLElement>("[data-active-word]");
    if (!el) return;
    const cRect = c.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < cRect.top + 48 || eRect.bottom > cRect.bottom - 48) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [mtgAudioTime]);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  };

  // Copy the open view: diarize -> "Speaker: text" blocks (with speakers, no
  // title); transcript -> the full plain text.
  const handleCopy = async () => {
    if (!selectedMeeting) return;
    let text = "";
    if (detailView === "diarize") {
      const rows = getDiarizedRows(selectedMeeting) ?? [];
      text = rows.map((r) => `${r.speaker}: ${r.text}`).join("\n\n");
    } else {
      text = getPlainText(selectedMeeting);
    }
    const ok = await copyToClipboard(text.trim());
    showToast(ok ? "Copied to clipboard" : "Copy failed");
  };

  const handleExport = async (meeting: Meeting) => {
    const view = detailView === "transcript" ? "transcript" : "diarize";
    const rows = getDiarizedRows(meeting) ?? [];
    const exportRows = rows.map((r) => ({ speaker: r.speaker, text: r.text }));
    const plainText = getPlainText(meeting);
    const base = meeting.topic.replace(/[^a-z0-9]/gi, "_") || "Transcript";
    const kind = view === "diarize" ? "Diarized" : "Transcript";
    const defaultName = `${base}_${kind}.txt`;

    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (api?.exportTranscript) {
      const res = await api.exportTranscript({
        plainText,
        diarized: exportRows,
        view,
        title: meeting.topic,
        defaultName,
      });
      if (res.saved) showToast("Transcript saved.");
      return;
    }

    const formattedDate = new Date(meeting.date).toLocaleString();
    const body =
      view === "diarize" && exportRows.length
        ? exportRows.map((t) => `${t.speaker}: ${t.text}`).join("\n\n")
        : plainText;
    const exportText = `${meeting.topic}\n${formattedDate}\n\n${body}`;
    const blob = new Blob([exportText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}_Transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Exporting transcript...");
  };

  const loadLocalMeetings = () => setMeetings(loadMeetings());

  const startEditing = (meeting: Meeting) => {
    setEditingId(meeting.id);
    setEditValue(meeting.topic);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditValue("");
  };

  const saveTopicEdit = async (meeting: Meeting) => {
    const newTopic = editValue.trim();
    if (!newTopic || newTopic === meeting.topic) {
      cancelEditing();
      return;
    }

    let newFilePath = meeting.filePath;
    const electron =
      typeof window !== "undefined" ? window.electronAPI : undefined;
    if (meeting.filePath && electron?.renameTranscriptFile) {
      try {
        const res = await electron.renameTranscriptFile(
          meeting.filePath,
          newTopic,
        );
        if (res?.renamed && res.filePath) newFilePath = res.filePath;
      } catch {}
    }

    updateMeeting(meeting.id, { topic: newTopic, filePath: newFilePath });
    loadLocalMeetings();
    cancelEditing();
    showToast("Renamed");
  };

  useEffect(() => {
    loadLocalMeetings();

    const handleInstantRefresh = () => loadLocalMeetings();
    window.addEventListener(MEETINGS_EVENT, handleInstantRefresh);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === "Escape" && selectedMeeting) setSelectedMeeting(null);
      if (e.key === "Escape" && isCalendarOpen) setIsCalendarOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener(MEETINGS_EVENT, handleInstantRefresh);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedMeeting, isCalendarOpen]);

  const processedMeetings = useMemo(() => {
    let filtered = meetings;
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      filtered = meetings.filter((m) => {
        // Search the title AND the transcript content, so any remembered word
        // from the meeting finds it — not just words in the auto-generated title.
        const haystack = [
          m.topic,
          m.plainText,
          ...(m.transcript?.map((t) => t.text) ?? []),
          ...(m.diarized?.map((d) => d.text) ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    } else if (selectedDate) {
      filtered = meetings.filter((m) => {
        const d = new Date(m.date);
        const meetingDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return meetingDateStr === selectedDate;
      });
    }
    return filtered.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  }, [meetings, debouncedSearch, selectedDate]);

  const datesWithMeetings = useMemo(() => {
    const dateSet = new Set<string>();
    meetings.forEach((meeting) => {
      const d = new Date(meeting.date);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dateSet.add(dateStr);
    });
    return dateSet;
  }, [meetings]);

  const statsByDate = useMemo(() => {
    const map = new Map<string, { count: number; totalSec: number }>();
    meetings.forEach((meeting) => {
      const d = new Date(meeting.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const entry = map.get(key) || { count: 0, totalSec: 0 };
      entry.count += 1;
      entry.totalSec += Number(meeting.durationSec) || 0;
      map.set(key, entry);
    });
    return map;
  }, [meetings]);

  const confirmDelete = () => {
    if (!meetingToDelete) return;
    const updated = meetings.filter((m) => m.id !== meetingToDelete);
    setMeetings(updated);
    saveMeetings(updated);
    setMeetingToDelete(null);
  };

  const openMeeting = (meeting: Meeting) => {
    setSelectedMeeting(meeting);
    setDetailView(getDiarizedRows(meeting) ? "diarize" : "transcript");
    setShowDiarizeConfirm(false);
    setShowDiarizeRetry(false);
    setDiarizing(false);
    setDiarizeProgress(0);
    setMtgHighlights(meeting.highlights ?? []);
    setMtgShowHighlights(meeting.highlightsShown ?? true);
    setMtgHighlightsOnly(false);
    setMtgHlButton(null);
    setMtgAudioTime(0);
  };

  const persistHighlights = (
    meeting: Meeting,
    next: string[],
    shown: boolean,
  ) => {
    updateMeeting(meeting.id, {
      highlights: next.length ? next : undefined,
      highlightsShown: shown,
    });
    const updated = { ...meeting, highlights: next, highlightsShown: shown };
    setMeetings((prev) => prev.map((m) => (m.id === meeting.id ? updated : m)));
    setSelectedMeeting(updated);
  };

  const handleMtgMouseUp = () => {
    if (detailView !== "diarize") {
      setMtgHlButton(null);
      return;
    }
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    const text = sel?.toString().trim() ?? "";
    if (!sel || sel.rangeCount === 0 || text.length < 2) {
      setMtgHlButton(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setMtgHlButton({ x: rect.left + rect.width / 2, y: rect.top, text });
  };

  const mtgIsHighlighted = (text: string) =>
    mtgHighlights.some(
      (h) => h === text || h.includes(text) || text.includes(h),
    );

  const addMtgHighlight = () => {
    if (!mtgHlButton || !selectedMeeting) return;
    const text = mtgHlButton.text;
    const already = mtgIsHighlighted(text);
    const next = already
      ? mtgHighlights.filter(
          (h) => !(h === text || h.includes(text) || text.includes(h)),
        )
      : [...mtgHighlights, text];
    setMtgHighlights(next);
    setMtgHlButton(null);
    window.getSelection?.()?.removeAllRanges();
    persistHighlights(selectedMeeting, next, true);
  };

  const runReDiarize = async (meeting: Meeting) => {
    if (!meeting.audioPath) {
      showToast("Original audio not available for this meeting.");
      return;
    }
    setShowDiarizeConfirm(false);
    setShowDiarizeRetry(false);
    setDiarizing(true);
    setDiarizeProgress(2);
    let creep: ReturnType<typeof setInterval> | null = null;
    const stopCreep = () => {
      if (creep) {
        clearInterval(creep);
        creep = null;
      }
    };
    const onChunk = (done: number, total: number) => {
      const t = total > 0 ? total : 1;
      const base = (done / t) * 100;
      setDiarizeProgress((p) => (base > p ? base : p));
      stopCreep();
      if (done >= t) return;
      const next = ((done + 1) / t) * 100;
      const startT = Date.now();
      creep = setInterval(() => {
        const elapsed = Date.now() - startT;
        const frac = elapsed / (elapsed + 30000);
        const val = base + (next - base) * frac;
        setDiarizeProgress((p) => (val > p ? val : p));
      }, 200);
    };
    try {
      const rows = await diarizeAudioFile(meeting.audioPath, {
        jwt: localStorage.getItem("token"),
        onProgress: onChunk,
      });
      const diarized = rows.map((r) => ({
        speaker: r.speaker,
        text: r.text,
        start: r.start,
        end: r.end,
        words: r.words,
      }));
      stopCreep();
      setDiarizeProgress(100);
      updateMeeting(meeting.id, { diarized });
      const updated = { ...meeting, diarized };
      setMeetings((prev) =>
        prev.map((m) => (m.id === meeting.id ? updated : m)),
      );
      setSelectedMeeting(updated);
      setDiarizing(false);
      setDetailView("diarize");
      showToast("Diarization complete");
    } catch {
      stopCreep();
      setDiarizing(false);
      setDiarizeProgress(0);
      setShowDiarizeRetry(true);
    }
  };

  const calendarPanel = (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
      <div className="flex justify-between items-center mb-6">
        <span className="text-sm font-bold text-slate-800">Date Filter</span>
        {selectedDate && (
          <button
            onClick={() => setSelectedDate(null)}
            className="text-[10px] font-bold text-red-500 hover:text-red-700 uppercase tracking-widest bg-red-50 px-2 py-1 rounded"
          >
            Clear Filter
          </button>
        )}
      </div>

      <Calendar
        onChange={(date) => {
          const d = date as Date;
          const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          setSelectedDate(dateStr);
          setIsCalendarOpen(false);
        }}
        value={selectedDate ? new Date(selectedDate) : null}
        tileContent={({ date, view }) => {
          if (view !== "month") return null;
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
          const stats = statsByDate.get(dateStr) || { count: 0, totalSec: 0 };
          return (
            <>
              {stats.count > 0 && (
                <div className="flex justify-center mt-1">
                  <span className="w-1.5 h-1.5 bg-[#e91e63] rounded-full"></span>
                </div>
              )}
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-max -translate-x-1/2 rounded-lg bg-slate-900 px-2.5 py-1.5 text-center text-[11px] font-semibold leading-tight text-white shadow-xl group-hover:block"
              >
                {stats.count} {stats.count === 1 ? "meeting" : "meetings"}
                <span className="mt-0.5 block font-normal text-slate-300">
                  {formatDuration(stats.totalSec)}
                </span>
                <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-slate-900" />
              </span>
            </>
          );
        }}
        tileClassName={({ date, view }) => {
          if (view === "month") {
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            const base = "group relative overflow-visible";
            if (selectedDate === dateStr)
              return `${base} bg-indigo-50 !rounded-lg text-indigo-700 font-bold border border-indigo-200`;
            return base;
          }
          return null;
        }}
        className="react-calendar-custom !w-full !border-none"
      />

      <div className="mt-6 pt-4 border-t border-slate-100 flex items-center gap-2">
        <span className="w-2.5 h-2.5 bg-[#e91e63] rounded-full"></span>
        <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">
          Session Held
        </span>
      </div>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden bg-slate-50/50 p-4 sm:p-6 lg:p-8 relative w-full h-full custom-scrollbar">
      <div className="max-w-7xl mx-auto w-full h-full flex flex-col">
        <div className="mb-8 shrink-0">
          <h2 className="text-2xl sm:text-3xl font-black text-slate-800 tracking-tight">
            Meeting Records
          </h2>
        </div>

        <div className="flex flex-col lg:flex-row gap-8 flex-1 min-h-0 items-start">
          <div className="flex-1 flex flex-col w-full min-w-0 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden h-full">
            <div className="p-4 border-b border-slate-100 bg-slate-50/50 shrink-0">
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <svg
                    className="w-4 h-4 text-slate-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.5}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search meetings..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-slate-900 transition-all font-medium placeholder:text-slate-400 shadow-sm"
                />
                </div>
                <button
                  onClick={() => setIsCalendarOpen(true)}
                  aria-label="Open calendar filter"
                  className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-indigo-300 hover:text-indigo-600 lg:hidden"
                >
                  <CalendarDays className="h-5 w-5" />
                  {selectedDate && (
                    <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-indigo-500 ring-2 ring-white" />
                  )}
                </button>
              </div>
            </div>

            <div className="p-4 flex-1 overflow-y-auto custom-scrollbar space-y-2">
              {processedMeetings.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-20">
                  <p className="text-slate-400 text-sm font-medium">
                    {selectedDate
                      ? "No meetings stored on this date."
                      : "No meetings stored yet."}
                  </p>
                </div>
              ) : (
                processedMeetings.map((meeting) => (
                  <div
                    key={meeting.id}
                    className="bg-white px-4 py-3 rounded-xl border border-slate-100 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all duration-300 flex flex-col md:flex-row md:items-center justify-between gap-4 group w-full"
                  >
                    <div className="flex-1 min-w-0 w-full">
                      {editingId === meeting.id ? (
                        <div className="mb-1.5 flex items-center gap-2">
                          <input
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveTopicEdit(meeting);
                              if (e.key === "Escape") cancelEditing();
                            }}
                            onBlur={() => saveTopicEdit(meeting)}
                            className="w-full rounded-lg border border-indigo-300 px-2.5 py-1.5 text-[15px] font-bold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-500/30"
                          />
                          <button
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => saveTopicEdit(meeting)}
                            className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <h3
                          onDoubleClick={() => startEditing(meeting)}
                          title="Double-click to rename"
                          className="font-bold text-[15px] text-slate-800 mb-1.5 w-full break-words cursor-text"
                        >
                          {meeting.topic}
                        </h3>
                      )}
                      <div className="flex items-center gap-3 text-xs font-semibold text-slate-500">
                        <span>
                          {new Date(meeting.date).toLocaleDateString()}
                        </span>
                        <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                        <span>
                          {new Date(meeting.date).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 w-full md:w-auto shrink-0 flex-wrap sm:flex-nowrap">
                      <button
                        onClick={() => openMeeting(meeting)}
                        className="flex-1 sm:flex-none text-xs font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-4 py-2 rounded-lg hover:bg-indigo-600 hover:text-white transition-all shadow-sm whitespace-nowrap"
                      >
                        View Transcript
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setMeetingToDelete(meeting.id);
                        }}
                        className="flex items-center justify-center p-2 bg-slate-50 text-slate-400 border border-slate-100 rounded-lg hover:bg-red-50 hover:text-red-500 hover:border-red-100 transition-all shadow-sm shrink-0"
                        title="Delete Record"
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
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="hidden lg:block w-full lg:w-[350px] shrink-0 sticky top-0">
            {calendarPanel}
          </div>
        </div>
      </div>

      {isCalendarOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm lg:hidden animate-in fade-in duration-200"
          onClick={() => setIsCalendarOpen(false)}
        >
          <div
            className="w-full max-w-sm animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {calendarPanel}
            <button
              onClick={() => setIsCalendarOpen(false)}
              className="mt-3 w-full rounded-xl bg-white py-3 text-sm font-bold text-slate-600 shadow-sm transition-colors hover:bg-slate-100"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {meetingToDelete && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-sm w-full shadow-2xl border border-slate-100">
            <div className="w-12 h-12 bg-red-50 rounded-full flex items-center justify-center mb-5 border border-red-100">
              <svg
                className="w-6 h-6 text-red-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </div>
            <h3 className="text-xl font-black text-slate-900 mb-2">
              Delete File?
            </h3>
            <p className="text-sm text-slate-500 font-medium mb-8 leading-relaxed">
              Are you sure you want to permanently delete this locally saved
              transcription? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setMeetingToDelete(null)}
                className="flex-1 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-xl shadow-lg transition-all"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedMeeting && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-6 backdrop-blur-sm"
          onClick={() => setSelectedMeeting(null)}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-white/20 flex justify-between items-center bg-linear-to-r from-violet-500 to-blue-500 rounded-t-2xl">
              <h2 className="text-xl font-bold text-white">
                {selectedMeeting.topic}
              </h2>
              <div className="flex items-center gap-2">
                {typeof selectedMeeting.durationSec === "number" &&
                  selectedMeeting.durationSec > 0 && (
                    <span
                      className="flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1.5 text-xs font-bold text-white ring-1 ring-white/30"
                      title="Total meeting duration"
                    >
                      <Clock className="h-3.5 w-3.5" />
                      {formatDuration(selectedMeeting.durationSec)}
                    </span>
                  )}
                {detailView === "diarize" && (
                  <button
                    onClick={() => setMtgHighlightsOnly((v) => !v)}
                    className={`p-2 rounded-full transition-colors ${
                      mtgHighlightsOnly
                        ? "bg-white/25 text-white"
                        : "text-white/80 hover:bg-white/20 hover:text-white"
                    }`}
                    title={mtgHighlightsOnly ? "Show all" : "Only highlights"}
                    aria-label="Toggle highlights view"
                  >
                    <Highlighter className="w-5 h-5" />
                  </button>
                )}
                <button
                  onClick={handleCopy}
                  className="p-2 text-white/80 hover:bg-white/20 hover:text-white rounded-full transition-colors"
                  title="Copy content"
                  aria-label="Copy content"
                >
                  <Copy className="w-5 h-5" />
                </button>
                <button
                  onClick={() => handleExport(selectedMeeting)}
                  className="p-2 text-white/80 hover:bg-white/20 hover:text-white rounded-full transition-colors"
                  title="Export transcript"
                  aria-label="Export transcript"
                >
                  <Download className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setSelectedMeeting(null)}
                  className="p-2 text-white/80 hover:bg-white/20 hover:text-white rounded-full transition-colors"
                  title="Close"
                  aria-label="Close"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-6 py-3">
              {selectedMeeting.audioMediaUrl && (
                <div className="min-w-0 flex-1">
                  <AudioPlayer
                    src={selectedMeeting.audioMediaUrl}
                    onTimeUpdate={setMtgAudioTime}
                    durationSec={selectedMeeting.durationSec}
                  />
                </div>
              )}
              <button
                onClick={() => {
                  if (diarizing) return;
                  if (detailView === "diarize") {
                    setDetailView("transcript");
                  } else if (getDiarizedRows(selectedMeeting)) {
                    setDetailView("diarize");
                  } else {
                    setShowDiarizeConfirm(true);
                  }
                }}
                disabled={diarizing}
                className={`relative shrink-0 overflow-hidden rounded-lg px-4 py-1.5 text-xs font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                  diarizing
                    ? "bg-slate-200 text-slate-700"
                    : "bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE] text-white hover:from-[#28a29a] hover:to-[#2a61a8]"
                } ${selectedMeeting.audioMediaUrl ? "" : "ml-auto"}`}
              >
                {diarizing && (
                  <span
                    className="absolute inset-y-0 left-0 bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE] transition-[width] duration-200"
                    style={{ width: `${diarizeProgress}%` }}
                  />
                )}
                <span className="relative">
                  {diarizing
                    ? `Diarizing… ${Math.round(diarizeProgress)}%`
                    : detailView === "diarize"
                      ? "Diarize"
                      : "Transcript"}
                </span>
              </button>
            </div>

            <div
              ref={mtgScrollRef}
              onMouseUp={handleMtgMouseUp}
              onScroll={() => setMtgHlButton(null)}
              className="p-6 overflow-y-auto space-y-4 text-[15px] text-slate-700 custom-scrollbar"
            >
              {diarizing ? (
                <p className="py-16 text-center text-sm font-semibold text-slate-500">
                  Separating speakers…
                </p>
              ) : mtgHighlightsOnly && mtgHighlights.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No highlights yet — select text and click Highlight.
                </p>
              ) : !mtgHighlightsOnly && detailView === "transcript" ? (
                <div className="whitespace-pre-wrap leading-relaxed">
                  {(() => {
                    // Karaoke in transcript view too: flatten the diarized words
                    // (with their timings) into one stream and highlight the word
                    // being spoken. Falls back to plain text if no word timings.
                    const rows = getDiarizedRows(selectedMeeting);
                    const allWords = rows
                      ? rows.flatMap((r) => r.words ?? [])
                      : [];
                    if (allWords.length === 0) {
                      return (
                        <HighlightedText
                          text={getPlainText(selectedMeeting)}
                          phrases={mtgHighlights}
                          enabled={mtgShowHighlights}
                        />
                      );
                    }
                    const rowText = allWords.map((w) => w.word).join(" ");
                    const hlRanges =
                      mtgShowHighlights && mtgHighlights.length
                        ? highlightRanges(rowText, mtgHighlights)
                        : [];
                    const wordStarts: number[] = [];
                    let acc = 0;
                    for (const w of allWords) {
                      wordStarts.push(acc);
                      acc += w.word.length + 1;
                    }
                    return allWords.map((w, wi) => {
                      const isActive =
                        mtgAudioTime >= w.start && mtgAudioTime < w.end;
                      const wStart = wordStarts[wi];
                      const wEnd = wStart + w.word.length;
                      const isHl = hlRanges.some(
                        ([s, e]) => wStart < e && wEnd > s,
                      );
                      return (
                        <span
                          key={wi}
                          data-active-word={isActive ? "" : undefined}
                          className={
                            isActive
                              ? "rounded-md bg-indigo-100 px-1 py-0.5 font-bold text-indigo-700 ring-1 ring-indigo-200 transition-all duration-150"
                              : isHl
                                ? "rounded bg-amber-200/70 px-0.5 transition-all duration-150"
                                : "transition-all duration-150"
                          }
                        >
                          {w.word}{" "}
                        </span>
                      );
                    });
                  })()}
                </div>
              ) : (
                (() => {
                  const allRows = getDiarizedRows(selectedMeeting);
                  if (!allRows) {
                    return (
                      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                        <p className="text-sm text-slate-500">
                          This meeting hasn&apos;t been diarized yet.
                        </p>
                        <button
                          onClick={() => setShowDiarizeConfirm(true)}
                          className="rounded-lg bg-linear-to-r from-violet-500 to-blue-500 px-5 py-2 text-sm font-bold text-white shadow-sm"
                        >
                          Diarize now
                        </button>
                      </div>
                    );
                  }
                  const order: string[] = [];
                  allRows.forEach((r) => {
                    if (!order.includes(r.speaker)) order.push(r.speaker);
                  });
                  const rows = mtgHighlightsOnly
                    ? allRows.filter((r) => {
                        const rt = r.words?.length
                          ? r.words.map((w) => w.word).join(" ")
                          : r.text;
                        return highlightRanges(rt, mtgHighlights).length > 0;
                      })
                    : allRows;
                  return rows.map((t, idx) => {
                    if (!order.includes(t.speaker)) order.push(t.speaker);
                    const color =
                      SPEAKER_HEX[
                        order.indexOf(t.speaker) % SPEAKER_HEX.length
                      ];
                    const words = t.words ?? [];
                    const rowText = words.map((w) => w.word).join(" ");
                    const hlRanges =
                      mtgShowHighlights && mtgHighlights.length && words.length
                        ? highlightRanges(rowText, mtgHighlights)
                        : [];
                    const wordStarts: number[] = [];
                    let acc = 0;
                    for (const w of words) {
                      wordStarts.push(acc);
                      acc += w.word.length + 1;
                    }
                    return (
                      <div
                        key={idx}
                        className="rounded-xl border border-l-4 border-slate-100 bg-white p-4 shadow-sm"
                        style={{ borderLeftColor: color }}
                      >
                        {editingMtgSpeakerIdx === idx ? (
                          <input
                            autoFocus
                            value={mtgSpeakerDraft}
                            onChange={(e) => setMtgSpeakerDraft(e.target.value)}
                            onBlur={() => commitMtgSpeakerRename(t.speaker)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                commitMtgSpeakerRename(t.speaker);
                              if (e.key === "Escape")
                                setEditingMtgSpeakerIdx(null);
                            }}
                            className="mb-1 w-36 rounded border border-slate-300 bg-white px-2 py-0.5 text-sm font-bold outline-none focus:ring-2 focus:ring-violet-500/40"
                            style={{ color }}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingMtgSpeakerIdx(idx);
                              setMtgSpeakerDraft(t.speaker);
                            }}
                            title="Click to rename this speaker everywhere"
                            className="mb-1 block text-sm font-bold hover:underline"
                            style={{ color }}
                          >
                            {t.speaker}
                          </button>
                        )}
                        <p className="leading-relaxed text-slate-700">
                          {words.length > 0 ? (
                            words.map((w, wi) => {
                              const isActive =
                                mtgAudioTime >= w.start &&
                                mtgAudioTime < w.end;
                              const wStart = wordStarts[wi];
                              const wEnd = wStart + w.word.length;
                              const isHl = hlRanges.some(
                                ([s, e]) => wStart < e && wEnd > s,
                              );
                              return (
                                <span
                                  key={wi}
                                  data-active-word={isActive ? "" : undefined}
                                  className={
                                    isActive
                                      ? "rounded-md bg-indigo-100 px-1 py-0.5 font-bold text-indigo-700 ring-1 ring-indigo-200 transition-all duration-150"
                                      : isHl
                                        ? "rounded bg-amber-200/70 px-0.5 transition-all duration-150"
                                        : "transition-all duration-150"
                                  }
                                >
                                  {w.word}{" "}
                                </span>
                              );
                            })
                          ) : (
                            <HighlightedText
                              text={t.text}
                              phrases={mtgHighlights}
                              enabled={mtgShowHighlights}
                            />
                          )}
                        </p>
                      </div>
                    );
                  });
                })()
              )}
            </div>
          </div>
        </div>
      )}

      {showDiarizeConfirm && selectedMeeting && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-slate-100 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Diarize this meeting?
            </h3>
            {selectedMeeting.audioPath ? (
              <>
                <p className="mt-2 text-sm text-slate-500">
                  We&apos;ll separate the speakers using the original audio. This
                  can take a little while.
                </p>
                <div className="mt-7 flex gap-3">
                  <button
                    onClick={() => setShowDiarizeConfirm(false)}
                    className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => runReDiarize(selectedMeeting)}
                    className="flex-1 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600"
                  >
                    Diarize
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-slate-500">
                  The original audio for this meeting isn&apos;t available, so it
                  can&apos;t be diarized now.
                </p>
                <div className="mt-7">
                  <button
                    onClick={() => setShowDiarizeConfirm(false)}
                    className="w-full rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showDiarizeRetry && selectedMeeting && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-slate-100 bg-white p-7 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900">
              Diarization failed
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              We couldn&apos;t diarize this meeting. You can retry.
            </p>
            <div className="mt-7 flex gap-3">
              <button
                onClick={() => setShowDiarizeRetry(false)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-200"
              >
                Not now
              </button>
              <button
                onClick={() => runReDiarize(selectedMeeting)}
                className="flex-1 rounded-xl bg-linear-to-r from-violet-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {mtgHlButton && (
        <button
          onClick={addMtgHighlight}
          style={{ left: mtgHlButton.x, top: mtgHlButton.y - 44 }}
          className="fixed z-200 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-xl"
        >
          <Highlighter className="h-3.5 w-3.5" />
          {mtgIsHighlighted(mtgHlButton.text) ? "Unhighlight" : "Highlight"}
        </button>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-110 -translate-x-1/2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200">
          {toast}
        </div>
      )}
    </div>
  );
}
