const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  saveTranscript: (content, defaultName) =>
    ipcRenderer.invoke("save-transcript", { content, defaultName }),
});
