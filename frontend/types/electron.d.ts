export {};

declare global {
  interface ElectronAPI {
    isElectron: true;
    saveTranscript: (
      content: string,
      defaultName: string,
    ) => Promise<{ saved: boolean; filePath?: string }>;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
