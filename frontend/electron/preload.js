const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,

    // Resolve the absolute disk path of a File chosen via <input>/drag-drop without
    // reading its bytes into memory (Electron 33: file.path was removed).
    getPathForFile: (file) => webUtils.getPathForFile(file),

    saveTranscript: (content, defaultName) =>
        ipcRenderer.invoke("save-transcript", { content, defaultName }),
    saveTranscriptLocal: (data, baseName, extension) =>
        ipcRenderer.invoke("save-transcript-local", { data, baseName, extension }),
    getDesktopSourceId: () => ipcRenderer.invoke("get-desktop-source-id"),
    audioFileCreate: () => ipcRenderer.invoke("audio-file-create"),
    audioFileAppend: (filePath, chunk) =>
        ipcRenderer.invoke("audio-file-append", filePath, chunk),
    audioFileClose: (filePath) => ipcRenderer.invoke("audio-file-close", filePath),
    audioCompressAndRead: (filePath) =>
        ipcRenderer.invoke("audio-compress-and-read", filePath),
});