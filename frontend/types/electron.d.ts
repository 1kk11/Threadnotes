export {};

declare global {
  interface ElectronAPI {
    isElectron: true;
    getPathForFile: (file: File) => string;
    saveTranscript: (
      content: string,
      defaultName: string,
    ) => Promise<{ saved: boolean; filePath?: string }>;
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
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
