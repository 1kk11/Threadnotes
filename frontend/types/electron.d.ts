export {};

declare global {
  interface ElectronAPI {
    isElectron: true;
    getPathForFile: (file: File) => string;
    saveTranscript: (
      content: string,
      defaultName: string,
    ) => Promise<{ saved: boolean; filePath?: string }>;
    saveAudio: (
      src: string,
      defaultName?: string,
    ) => Promise<{ saved: boolean; filePath?: string; reason?: string }>;
    exportTranscript: (payload: {
      plainText?: string;
      diarized?: { speaker: string; text: string }[];
      view: "diarize" | "transcript";
      title?: string;
      defaultName?: string;
    }) => Promise<{ saved: boolean; filePath?: string; reason?: string }>;
    renameTranscriptFile: (
      oldPath: string,
      newBaseName: string,
    ) => Promise<{ renamed: boolean; filePath?: string; reason?: string }>;
    onCloseRequested: (callback: () => void) => () => void;
    confirmClose: () => void;
    windowMinimize: () => void;
    windowMaximizeToggle: () => void;
    windowClose: () => void;
    recorderSetActive: (active: boolean) => void;
    recorderSetState: (state: { timeText: string; isPaused: boolean }) => void;
    recorderAction: (action: "pause" | "resume" | "stop") => void;
    onRecorderState: (
      callback: (state: { timeText: string; isPaused: boolean }) => void,
    ) => () => void;
    onRecorderAction: (
      callback: (action: "pause" | "resume" | "stop") => void,
    ) => () => void;
    saveTranscriptLocal: (
      data: unknown,
      baseName?: string,
      extension?: string,
    ) => Promise<{ saved: boolean; filePath?: string }>;
    getDesktopSourceId: () => Promise<string>;
    audioFileCreate: () => Promise<string>;
    audioFileAppend: (
      filePath: string,
      chunk: ArrayBuffer,
    ) => Promise<boolean>;
    audioFileClose: (filePath: string) => Promise<boolean>;
    audioCompressAndRead: (
      filePath: string,
    ) => Promise<{
      chunks: { buffer: ArrayBuffer; name: string }[];
      segmentSeconds: number;
      mimeType: string;
    }>;
    remuxAudio: (
      filePath: string,
    ) => Promise<{ outputPath: string; fileName: string; mediaUrl: string }>;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
