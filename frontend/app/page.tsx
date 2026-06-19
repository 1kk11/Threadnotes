"use client";
import Sidebar from "@/components/Sidebar";
import CapturePanel from "@/components/CapturePanel";
import MyMeetings from "@/components/MyMeetings";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

type TranscriptEntry = {
  speaker: string;
  text: string;
  timestamp: string;
  isFinal?: boolean;
  start?: number;
  end?: number;
  words?: { word: string; start: number; end: number }[];
};

function normalizeEntry(data: any): TranscriptEntry {
  let finalSpeaker = data.speaker || "Speaker";
  let finalText = data.text || "";

  const match = finalText.match(/^\[(.*?)\]\s*(.*)/);
  if (match) {
    finalSpeaker = match[1];
    finalText = match[2];
  }

  if (finalSpeaker.startsWith("Guest-")) {
    const num = parseInt(finalSpeaker.split("-")[1], 10);
    if (!isNaN(num)) {
      finalSpeaker = `Speaker ${String.fromCharCode(64 + num)}`;
    }
  } else if (finalSpeaker.toLowerCase() === "unknown") {
    finalSpeaker = "Speaker";
  }

  const timeString = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return {
    speaker: finalSpeaker,
    text: finalText,
    timestamp: data.timestamp || timeString,
    isFinal: data.isFinal,
    start: data.start,
    end: data.end,
    words: data.words,
  };
}

export default function Home() {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);

  const [currentView, setCurrentView] = useState("dashboard");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [showNewConvoModal, setShowNewConvoModal] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/auth");
    } else {
      setIsAuthorized(true);
    }
  }, [router]);

  const handleTranscriptUpdate = useCallback((data: any) => {
    setTranscript((prev) => [...prev, normalizeEntry(data)]);
  }, []);

  // Swap the live draft for the final diarized + word-aligned transcript in one
  // atomic update (never passes through length 0, so the reset effect is safe).
  const handleReplaceTranscript = useCallback((segments: any[]) => {
    setTranscript(segments.map(normalizeEntry));
  }, []);

  const handleRecordingChange = useCallback((recording: boolean) => {
    setIsRecording(recording);
  }, []);

  const handleTranscriptEdit = useCallback((index: number, newText: string) => {
    setTranscript((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], text: newText };
      return updated;
    });
  }, []);

  const handleClearTranscript = useCallback(() => {
    setTranscript([]);
  }, []);

  const confirmNewConversation = () => {
    handleClearTranscript();
    setShowNewConvoModal(false);
    setCurrentView("dashboard");
  };

  const handleNewConversationClick = () => {
    if (transcript.length > 0) {
      setShowNewConvoModal(true);
    } else {
      handleClearTranscript();
      setCurrentView("dashboard");
    }
  };

  if (!isAuthorized) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-indigo-600 font-bold tracking-wide animate-pulse">
            Loading ThreadNotes...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-dvh w-full overflow-hidden bg-slate-50">
      <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0 z-30">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-1.5 rounded-md">
            <svg
              className="w-5 h-5 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
          </div>
          <h1 className="text-xl font-black text-slate-800 tracking-tight">
            ThreadNotes
          </h1>
        </div>

        <button
          onClick={handleNewConversationClick}
          className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-lg transition-all shadow-sm flex items-center gap-2"
        >
          <span>+</span> New Conversation
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        <Sidebar currentView={currentView} setCurrentView={setCurrentView} />

        <main className="flex-1 bg-slate-50/50 relative overflow-hidden flex flex-col">
          {currentView === "transcribe" && (
            <div className="flex-1 w-full h-full z-10 relative overflow-hidden">
              <MyMeetings />
            </div>
          )}

          <CapturePanel
            isHidden={currentView !== "dashboard"}
            transcript={transcript}
            isRecording={isRecording}
            onTranscriptUpdate={handleTranscriptUpdate}
            onRecordingChange={handleRecordingChange}
            onTranscriptEdit={handleTranscriptEdit}
            onClearTranscript={handleClearTranscript}
            onReplaceTranscript={handleReplaceTranscript}
          />
        </main>
      </div>

      {showNewConvoModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-sm w-full shadow-2xl border border-slate-100">
            <h3 className="text-xl font-black text-slate-900 mb-2">
              Start fresh?
            </h3>
            <p className="text-sm text-slate-500 font-medium mb-8 leading-relaxed">
              Are you sure you want to start a new conversation? Unsaved progress
              will be lost.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowNewConvoModal(false)}
                className="flex-1 px-4 py-3 bg-slate-100 text-slate-700 text-sm font-bold rounded-xl"
              >
                Cancel
              </button>
              <button
                onClick={confirmNewConversation}
                className="flex-1 px-4 py-3 bg-indigo-600 text-white text-sm font-bold rounded-xl"
              >
                Start New
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
