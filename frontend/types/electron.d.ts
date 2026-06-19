// Type definitions for the bridge exposed by electron/preload.js.
// `window.electronAPI` is undefined in a plain browser, so callers must guard.
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
