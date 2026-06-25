export {};

declare global {
  interface ElectronAPI {
    isElectron: true;
    saveTranscript: (
      content: string,
      defaultName: string,
    ) => Promise<{ saved: boolean; filePath?: string }>;
    getDesktopSourceId: () => Promise<string>;
    audioFileCreate: () => Promise<string>;
    audioFileAppend: (
      filePath: string,
      chunk: ArrayBuffer,
    ) => Promise<boolean>;
    audioFileClose: (filePath: string) => Promise<boolean>;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
