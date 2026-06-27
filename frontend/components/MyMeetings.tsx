"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import { Download, CalendarDays } from "lucide-react";
import { loadMeetings, saveMeetings, MEETINGS_EVENT } from "@/lib/meetingStore";

type TranscriptEntry = { speaker: string; text: string; timestamp: string };
type Meeting = {
  id: string;
  topic: string;
  date: string;
  transcript: TranscriptEntry[];
};

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

  const searchInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // FIX: New Export Logic for downloading .txt file
  const handleExport = (meeting: Meeting) => {
    const formattedDate = new Date(meeting.date).toLocaleString();
    const body = meeting.transcript
      .map((t) => `${t.speaker}: ${t.text}`)
      .join("\n\n");
    const exportText = `${meeting.topic}\n${formattedDate}\n\n${body}`;

    const blob = new Blob([exportText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meeting.topic.replace(/[^a-z0-9]/gi, "_")}_Transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Exporting transcript...");
  };

  const loadLocalMeetings = () => setMeetings(loadMeetings());

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
      filtered = meetings.filter((m) =>
        m.topic.toLowerCase().includes(debouncedSearch.toLowerCase()),
      );
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

  const confirmDelete = () => {
    if (!meetingToDelete) return;
    const updated = meetings.filter((m) => m.id !== meetingToDelete);
    setMeetings(updated);
    saveMeetings(updated);
    setMeetingToDelete(null);
  };

  // Shared calendar UI — rendered in the desktop side panel AND the mobile drawer
  // so both have identical functionality.
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
          setIsCalendarOpen(false); // close the mobile drawer after picking (no-op on desktop)
        }}
        value={selectedDate ? new Date(selectedDate) : null}
        tileContent={({ date, view }) => {
          if (view === "month") {
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            if (datesWithMeetings.has(dateStr)) {
              return (
                <div className="flex justify-center mt-1">
                  <span className="w-1.5 h-1.5 bg-[#e91e63] rounded-full"></span>
                </div>
              );
            }
          }
          return null;
        }}
        tileClassName={({ date, view }) => {
          if (view === "month") {
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            if (selectedDate === dateStr)
              return "bg-indigo-50 !rounded-lg text-indigo-700 font-bold border border-indigo-200";
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
                {/* Calendar toggle — mobile/tablet only; opens the calendar drawer. */}
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
                      <h3 className="font-bold text-[15px] text-slate-800 mb-1.5 truncate w-full">
                        {meeting.topic}
                      </h3>
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
                        onClick={() => setSelectedMeeting(meeting)}
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

          {/* Desktop calendar panel — hidden below lg (replaced by the icon toggle). */}
          <div className="hidden lg:block w-full lg:w-[350px] shrink-0 sticky top-0">
            {calendarPanel}
          </div>
        </div>
      </div>

      {/* Mobile calendar drawer/overlay (lg:hidden) */}
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
              <div className="flex items-center gap-1">
                {/* FIX: Calling handleExport and showing Download Icon */}
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
            <div className="p-6 overflow-y-auto space-y-4 text-[15px] text-slate-700 custom-scrollbar">
              {selectedMeeting.transcript.map((t, idx) => (
                <div
                  key={idx}
                  className="bg-white p-4 rounded-xl border border-slate-100 shadow-sm"
                >
                  <p>
                    <span className="font-bold text-slate-900 mr-2">
                      {t.speaker}:
                    </span>{" "}
                    {t.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-110 -translate-x-1/2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200">
          {toast}
        </div>
      )}
    </div>
  );
}
