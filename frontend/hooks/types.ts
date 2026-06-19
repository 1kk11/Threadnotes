// Shared transcript types used across the capture/playback UI.

export type Word = { word: string; start: number; end: number };

export type TranscriptEntry = {
  speaker: string;
  text: string;
  timestamp: string;
  isFinal?: boolean;
  // Optional timings for playback word/phrase highlighting.
  start?: number;
  end?: number;
  words?: Word[];
};
