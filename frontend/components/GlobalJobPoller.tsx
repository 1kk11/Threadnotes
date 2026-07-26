"use client";

import { useEffect } from "react";
import { getDiarizeJobStatus } from "@/lib/diarize";
import { loadMeetings, updateMeeting } from "@/lib/meetingStore";

export function GlobalJobPoller() {
  // Poll for background job completion globally (handles Render's 55s WebSocket timeout)
  // Runs entirely silently in the background.
  useEffect(() => {
    let active = true;

    const checkPendingJobs = async () => {
      const token = localStorage.getItem("token");
      if (!token) return;

      const currentMeetings = loadMeetings();
      let changed = false;

      for (const meeting of currentMeetings) {
        if (meeting.jobId && active) {
          try {
            const result = await getDiarizeJobStatus(meeting.jobId, token);
            if (result.status === "completed" && result.segments) {
              const diarized = result.segments.map((r: any) => ({
                speaker: r.speaker,
                text: r.text,
                start: r.start,
                end: r.end,
                words: r.words,
              }));
              updateMeeting(meeting.id, { diarized, jobId: undefined });
              changed = true;
              
              const api = typeof window !== "undefined" ? window.electronAPI : undefined;
              if (api?.showNotification) {
                api.showNotification("ThreadNotes", "Background diarization completed!");
              }
            } else if (result.status === "failed") {
              updateMeeting(meeting.id, { jobId: undefined });
              changed = true;
              
              const api = typeof window !== "undefined" ? window.electronAPI : undefined;
              if (api?.showNotification) {
                api.showNotification("ThreadNotes Error", "Background diarization failed: " + result.error);
              }
            }
          } catch (e) {
            // ignore network errors during polling
          }
        }
      }
    };

    // Initial check on mount
    checkPendingJobs();

    // Poll every 15 seconds
    const interval = setInterval(checkPendingJobs, 15000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return null; // Renders completely invisibly
}
