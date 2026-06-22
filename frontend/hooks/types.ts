export type Word = { word: string; start: number; end: number };

export type TranscriptEntry = {
  speaker: string;
  text: string;
  timestamp: string;
  isFinal?: boolean;
  start?: number;
  end?: number;
  words?: Word[];
};
