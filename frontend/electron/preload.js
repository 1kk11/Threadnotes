const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,

    getPathForFile: (file) => webUtils.getPathForFile(file),

    saveTranscript: (content, defaultName) =>
        ipcRenderer.invoke("save-transcript", { content, defaultName }),
    saveAudio: (src, defaultName) =>
        ipcRenderer.invoke("save-audio", { src, defaultName }),
    exportTranscript: (payload) =>
        ipcRenderer.invoke("export-transcript", payload),
    renameTranscriptFile: (oldPath, newBaseName) =>
        ipcRenderer.invoke("rename-transcript-file", { oldPath, newBaseName }),
    onCloseRequested: (callback) => {
        const listener = () => callback();
        ipcRenderer.on("app-close-requested", listener);
        return () => ipcRenderer.removeListener("app-close-requested", listener);
    },
    confirmClose: () => ipcRenderer.send("app-confirm-close"),
    windowMinimize: () => ipcRenderer.send("window-minimize"),
    windowMaximizeToggle: () => ipcRenderer.send("window-maximize-toggle"),
    windowClose: () => ipcRenderer.send("window-close"),

    // Floating recorder widget bridge.
    recorderSetActive: (active) =>
        ipcRenderer.send("recorder:set-active", active),
    recorderSetState: (state) => ipcRenderer.send("recorder:set-state", state),
    recorderAction: (action) => ipcRenderer.send("recorder:action", action),
    onRecorderState: (callback) => {
        const listener = (_e, state) => callback(state);
        ipcRenderer.on("recorder:state", listener);
        return () => ipcRenderer.removeListener("recorder:state", listener);
    },
    onRecorderAction: (callback) => {
        const listener = (_e, action) => callback(action);
        ipcRenderer.on("recorder:action", listener);
        return () => ipcRenderer.removeListener("recorder:action", listener);
    },
    saveTranscriptLocal: (data, baseName, extension) =>
        ipcRenderer.invoke("save-transcript-local", { data, baseName, extension }),
    getDesktopSourceId: () => ipcRenderer.invoke("get-desktop-source-id"),
    audioFileCreate: () => ipcRenderer.invoke("audio-file-create"),
    audioFileAppend: (filePath, chunk) =>
        ipcRenderer.invoke("audio-file-append", filePath, chunk),
    audioFileClose: (filePath) => ipcRenderer.invoke("audio-file-close", filePath),
    audioCompressAndRead: (filePath) =>
        ipcRenderer.invoke("audio-compress-and-read", filePath),
    remuxAudio: (filePath) => ipcRenderer.invoke("remux-audio", filePath),
});