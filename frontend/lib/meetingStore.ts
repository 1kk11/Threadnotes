const LEGACY_KEY = "threadnotes_local_history";
const PREFIX = "threadnotes_history_";
export const MEETINGS_EVENT = "meetingSavedLocally";

export type StoredMeeting = {
  id: string;
  topic: string;
  date: string;
  transcript: { speaker: string; text: string; timestamp: string }[];
};

function currentUserId(): string {
  if (typeof window === "undefined") return "anon";
  const token = localStorage.getItem("token");
  if (!token) return "anon";
  try {
    const payload = token.split(".")[1];
    if (!payload) return "anon";
    const json = JSON.parse(
      decodeURIComponent(
        atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
          .split("")
          .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join(""),
      ),
    );
    const sub = json.sub || json.email;
    return typeof sub === "string" && sub ? sub.toLowerCase() : "anon";
  } catch {
    return "anon";
  }
}

function storageKey(): string {
  return `${PREFIX}${currentUserId()}`;
}

function migrateLegacy(key: string): void {
  if (typeof window === "undefined") return;
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (!legacy) return;
  if (!localStorage.getItem(key)) localStorage.setItem(key, legacy);
  localStorage.removeItem(LEGACY_KEY);
}

export function loadMeetings(): StoredMeeting[] {
  if (typeof window === "undefined") return [];
  const key = storageKey();
  migrateLegacy(key);
  try {
    const stored = localStorage.getItem(key);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMeetings(meetings: StoredMeeting[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(storageKey(), JSON.stringify(meetings));
}

export function addMeeting(meeting: StoredMeeting): void {
  saveMeetings([meeting, ...loadMeetings()]);
  window.dispatchEvent(new Event(MEETINGS_EVENT));
}

export function clearMeetings(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(storageKey());
}
