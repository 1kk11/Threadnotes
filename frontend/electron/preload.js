const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,

    saveTranscript: (content, defaultName) =>
        ipcRenderer.invoke("save-transcript", { content, defaultName }),
    getDesktopSourceId: () => ipcRenderer.invoke("get-desktop-source-id"),
    audioFileCreate: () => ipcRenderer.invoke("audio-file-create"),
    audioFileAppend: (filePath, chunk) =>
        ipcRenderer.invoke("audio-file-append", filePath, chunk),
    audioFileClose: (filePath) => ipcRenderer.invoke("audio-file-close", filePath),
});