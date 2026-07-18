const {
    app,
    BrowserWindow,
    Menu,
    protocol,
    net,
    session,
    ipcMain,
    dialog,
    desktopCapturer,
    screen,
    Tray,
    nativeImage,
    Notification
} = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const isDev = !app.isPackaged;

// Force a consistent app-data folder name in BOTH dev and packaged builds. Without
// this, dev runs use the package.json name ("frontend") → data lands in
// AppData\Roaming\frontend, which is why it seemed to "disappear". Now everything
// always lives under AppData\Roaming\ThreadNotes. Must run before any getPath().
app.setName("ThreadNotes");

const audioWriteStreams = new Map();

// Store audio in the OS-standard per-user data dir (AppData\Roaming\ThreadNotes
// on Windows). This location is NEVER touched by the installer, so recordings —
// and the localStorage that holds meetings + the login token — survive
// reinstalls. (Do NOT move userData into the install folder: the NSIS uninstaller
// wipes the install dir on reinstall, which would clear meetings and force a
// re-login.)
function getRecordingsDirectory() {
    const recordingsDir = path.join(app.getPath("userData"), "recordings");
    fs.mkdirSync(recordingsDir, { recursive: true });
    return recordingsDir;
}

function createRecordingFilePath() {
    const recordingsDir = getRecordingsDirectory();
    const fileName = `meeting-${Date.now()}-${crypto.randomUUID()}.webm`;
    return path.join(recordingsDir, fileName);
}

let _ffmpegPathCache = null;

function getFfmpegPath() {
    if (_ffmpegPathCache) return _ffmpegPathCache;

    let staticPath = null;
    try {
        staticPath = require("ffmpeg-static");
    } catch (e) {
        console.warn("[ffmpeg] ffmpeg-static not resolvable:", e.message);
    }
    if (staticPath) {
        const unpacked = staticPath.replace("app.asar", "app.asar.unpacked");
        if (fs.existsSync(unpacked)) {
            _ffmpegPathCache = unpacked;
            return _ffmpegPathCache;
        }
        if (fs.existsSync(staticPath)) {
            _ffmpegPathCache = staticPath;
            return _ffmpegPathCache;
        }
    }

    const bundled = app.isPackaged
        ? path.join(process.resourcesPath, "ffmpeg.exe")
        : path.join(__dirname, "..", "resources", "ffmpeg.exe");
    if (fs.existsSync(bundled)) {
        _ffmpegPathCache = bundled;
        return _ffmpegPathCache;
    }

    console.warn("[ffmpeg] No bundled binary found — falling back to PATH.");
    _ffmpegPathCache = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    return _ffmpegPathCache;
}

function runFfmpeg(args, onProgress, knownDurationSec) {
    const ffmpegPath = getFfmpegPath();
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = spawn(ffmpegPath, args, { windowsHide: true });
        } catch (e) {
            return reject(
                new Error(`Failed to spawn FFmpeg at "${ffmpegPath}": ${e.message}`),
            );
        }
        let stderr = "";
        // Seed the total with a caller-supplied duration. WebM blobs from
        // MediaRecorder have no Duration header, so ffmpeg prints "Duration: N/A"
        // and progress could never be computed — the known length fixes that.
        let durationSec = Number(knownDurationSec) > 0 ? Number(knownDurationSec) : 0;
        proc.stderr.on("data", (d) => {
            const chunk = d.toString();
            stderr += chunk;
            // Real progress: parse total Duration once, then each time= update.
            if (onProgress) {
                if (!durationSec) {
                    const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
                    if (dm) {
                        durationSec =
                            (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
                    }
                }
                const tm = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
                if (tm && durationSec > 0) {
                    const t = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
                    const pct = Math.min(99, Math.round((t / durationSec) * 100));
                    try {
                        onProgress(pct);
                    } catch {}
                }
            }
        });
        proc.on("error", (e) =>
            reject(new Error(`FFmpeg spawn error ("${ffmpegPath}"): ${e.message}`)),
        );
        proc.on("exit", (code) => {
            if (code === 0) return resolve();
            reject(
                new Error(
                    `FFmpeg exited with code ${code} (binary: "${ffmpegPath}"). ` +
                    `stderr: ${stderr.slice(-800) || "(empty)"}`,
                ),
            );
        });
    });
}

function closeAllAudioStreams() {
    for (const [filePath, stream] of audioWriteStreams.entries()) {
        try {
            stream.end();
        } catch (error) {
            console.warn(`Failed to close audio stream for ${filePath}:`, error);
        }
        audioWriteStreams.delete(filePath);
    }
}

const DEV_URL = "http://localhost:3000";
const OUT_DIR = path.join(__dirname, "..", "out");

const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://local/`;

const MEDIA_SCHEME = "media";
const MEDIA_HOST = "recordings";

protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
        },
    },
    {
        scheme: MEDIA_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
        },
    },
]);

const MIME_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain",
    ".map": "application/json",
};

function handleAppProtocol(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname.endsWith("/")) pathname += "index.html";
    else if (!path.extname(pathname)) pathname += "/index.html";

    const filePath = path.normalize(path.join(OUT_DIR, pathname));
    if (!filePath.startsWith(OUT_DIR)) {
        return new Response("Forbidden", { status: 403 });
    }

    const fileUrl = pathToFileURL(filePath).toString();
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";

    return net.fetch(fileUrl).then(
        (res) =>
        new Response(res.body, {
            status: res.status,
            headers: { "Content-Type": mime },
        }),
    );
}

const AUDIO_MIME_TYPES = {
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".oga": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".wav": "audio/wav",
};

async function handleMediaProtocol(request) {
    const recordingsDir = getRecordingsDirectory();
    const url = new URL(request.url);
    const fileName = path.basename(decodeURIComponent(url.pathname));
    const filePath = path.normalize(path.join(recordingsDir, fileName));

    if (!filePath.startsWith(recordingsDir) || !fs.existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
    }

    const total = fs.statSync(filePath).size;
    const ext = path.extname(filePath).toLowerCase();
    const mime = AUDIO_MIME_TYPES[ext] || "application/octet-stream";

    const rangeHeader = request.headers.get("Range") || request.headers.get("range");
    if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        let start = match && match[1] ? parseInt(match[1], 10) : 0;
        let end = match && match[2] ? parseInt(match[2], 10) : total - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= total) end = total - 1;

        if (start > end || start >= total) {
            return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${total}` },
            });
        }

        const chunkSize = end - start + 1;
        const buffer = Buffer.alloc(chunkSize);
        const fd = fs.openSync(filePath, "r");
        try {
            fs.readSync(fd, buffer, 0, chunkSize, start);
        } finally {
            fs.closeSync(fd);
        }

        return new Response(buffer, {
            status: 206,
            headers: {
                "Content-Type": mime,
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Accept-Ranges": "bytes",
                "Content-Length": String(chunkSize),
            },
        });
    }

    const data = await fs.promises.readFile(filePath);
    return new Response(data, {
        status: 200,
        headers: {
            "Content-Type": mime,
            "Accept-Ranges": "bytes",
            "Content-Length": String(total),
        },
    });
}

let mainWindow = null;

let recorderWidget = null;
let recordingActive = false;

function getRecorderWidget() {
    if (recorderWidget && !recorderWidget.isDestroyed()) return recorderWidget;
    const W = 240;
    const H = 110;
    const { workArea } = screen.getPrimaryDisplay();
    recorderWidget = new BrowserWindow({
        width: W,
        height: H,
        x: workArea.x + 16,
        y: workArea.y + workArea.height - H - 16,
        frame: false,
        transparent: true,
        resizable: false,
        movable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    recorderWidget.setAlwaysOnTop(true, "screen-saver");
    recorderWidget.loadFile(path.join(__dirname, "widget.html"));
    recorderWidget.on("closed", () => {
        recorderWidget = null;
    });
    return recorderWidget;
}

function showRecorderWidget() {
    const w = getRecorderWidget();
    if (!w.isVisible()) w.showInactive();
}

function hideRecorderWidget() {
    if (recorderWidget && !recorderWidget.isDestroyed() && recorderWidget.isVisible()) {
        recorderWidget.hide();
    }
}

ipcMain.on("recorder:set-active", (_e, active) => {
    recordingActive = !!active;
    if (!recordingActive) {
        hideRecorderWidget();
    } else if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
        showRecorderWidget();
    }
});

ipcMain.on("recorder:set-state", (_e, state) => {
    if (recorderWidget && !recorderWidget.isDestroyed()) {
        recorderWidget.webContents.send("recorder:state", state);
    }
});

ipcMain.on("recorder:action", (_e, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (action === "expand") {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        return;
    }
    mainWindow.webContents.send("recorder:action", action);
    if (action === "stop") {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

function getBuildId() {
    try {
        const p = path.join(__dirname, "build-info.json");
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        return String(data.buildId || "dev");
    } catch {
        return "dev";
    }
}

ipcMain.on("app-confirm-close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.__allowClose = true;
        mainWindow.close();
    }
});

ipcMain.on("window-minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.on("window-maximize-toggle", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});

ipcMain.on("window-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
    }
});

ipcMain.on("window-close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
});

ipcMain.on("show-notification", (_event, { title, body }) => {
    const notification = new Notification({
        title,
        body,
        icon: path.join(__dirname, "..", "build", "icon.ico")
    });
    
    notification.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
    
    notification.show();
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 940,
        minHeight: 640,
        icon: path.join(__dirname, "..", "build", "icon.ico"),
        backgroundColor: "#f8fafc",
        autoHideMenuBar: true,
        frame: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    Menu.setApplicationMenu(null);

    mainWindow = win;
    win.__allowClose = false;
    win.on("close", (e) => {
        if (win.__allowClose) return;
        e.preventDefault();
        win.hide();
    });

    win.on("minimize", () => {
        if (recordingActive) showRecorderWidget();
    });
    win.on("restore", () => hideRecorderWidget());
    win.on("focus", () => hideRecorderWidget());
    win.on("closed", () => {
        if (recorderWidget && !recorderWidget.isDestroyed()) {
            recorderWidget.destroy();
        }
    });

    win.once("ready-to-show", () => {
        win.maximize();
        win.show();
    });

    const ZOOM_STEP = 0.1;
    const ZOOM_MIN = 0.6;
    const ZOOM_MAX = 1.6;
    win.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown" || !input.control || input.alt || input.meta) {
            return;
        }
        const wc = win.webContents;
        const key = input.key;
        if (key === "=" || key === "+" || key === "Add") {
            wc.setZoomFactor(Math.min(ZOOM_MAX, +(wc.getZoomFactor() + ZOOM_STEP).toFixed(2)));
            event.preventDefault();
        } else if (key === "-" || key === "Subtract") {
            wc.setZoomFactor(Math.max(ZOOM_MIN, +(wc.getZoomFactor() - ZOOM_STEP).toFixed(2)));
            event.preventDefault();
        } else if (key === "0") {
            wc.setZoomFactor(1.0);
            event.preventDefault();
        }
    });

    if (isDev) {
        win.loadURL(DEV_URL);
        win.webContents.openDevTools({ mode: "detach" });
    } else {
        win.loadURL(APP_ORIGIN);
    }

    return win;
}

app.whenReady().then(async () => {
    // Print exactly where user data is stored, so it's never a mystery.
    console.log("[ThreadNotes] Data folder :", app.getPath("userData"));
    console.log("[ThreadNotes] Recordings  :", getRecordingsDirectory());
    console.log("[ThreadNotes] Transcripts :", getLocalTranscriptsDirectory());

    protocol.handle(APP_SCHEME, handleAppProtocol);
    protocol.handle(MEDIA_SCHEME, handleMediaProtocol);

    session.defaultSession.setPermissionRequestHandler(
        (_wc, permission, callback) => {
            callback(permission === "media");
        },
    );
    session.defaultSession.setPermissionCheckHandler(
        (_wc, permission) => permission === "media",
    );

    try {
        const buildId = getBuildId();
        const markerPath = path.join(app.getPath("userData"), "build-id.txt");
        let prev = null;
        try {
            prev = fs.readFileSync(markerPath, "utf-8").trim();
        } catch {}
        if (prev !== buildId) {
            await session.defaultSession.clearCache();
            try {
                fs.writeFileSync(markerPath, buildId, "utf-8");
            } catch {}
        }
    } catch (err) {
        console.warn("[build-id] cache-bust check failed:", err);
    }

    // Setup System Tray
    const iconPath = path.join(__dirname, "..", "build", "icon.ico");
    const trayIcon = nativeImage.createFromPath(iconPath);
    const tray = new Tray(trayIcon);
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open ThreadNotes',
            click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    createWindow();
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit ThreadNotes',
            click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.__allowClose = true;
                    // Send close requested so dashboard checks unsaved changes
                    mainWindow.webContents.send("app-close-requested");
                } else {
                    app.quit();
                }
            }
        }
    ]);
    
    tray.setToolTip('ThreadNotes');
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isVisible()) {
                mainWindow.focus();
            } else {
                mainWindow.show();
            }
        } else {
            createWindow();
        }
    });

    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    closeAllAudioStreams();
    if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("save-transcript", async(_event, { content, defaultName }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: "Save Transcript",
        defaultPath: defaultName || "ThreadNotes_Transcript.txt",
        filters: [
            { name: "Text File", extensions: ["txt"] },
            { name: "All Files", extensions: ["*"] },
        ],
    });

    if (canceled || !filePath) return { saved: false };

    await fs.promises.writeFile(filePath, content, "utf-8");
    return { saved: true, filePath };
});

ipcMain.handle("save-audio", async(_event, { src, defaultName } = {}) => {
    if (!src || typeof src !== "string") return { saved: false, reason: "no-src" };

    let sourcePath = null;
    try {
        if (src.startsWith(`${MEDIA_SCHEME}://`)) {
            const recordingsDir = getRecordingsDirectory();
            const url = new URL(src);
            const fileName = path.basename(decodeURIComponent(url.pathname));
            const candidate = path.normalize(path.join(recordingsDir, fileName));
            if (candidate.startsWith(recordingsDir) && fs.existsSync(candidate)) {
                sourcePath = candidate;
            }
        } else if (fs.existsSync(src)) {
            sourcePath = src;
        }
    } catch {
        sourcePath = null;
    }

    if (!sourcePath) return { saved: false, reason: "not-found" };

    const ext = (path.extname(sourcePath) || ".ogg").toLowerCase();
    const baseDefault = defaultName || `recording${ext}`;

    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: "Save Recording",
        defaultPath: baseDefault,
        filters: [
            { name: "Audio", extensions: [ext.replace(/^\./, "") || "ogg"] },
            { name: "All Files", extensions: ["*"] },
        ],
    });

    if (canceled || !filePath) return { saved: false };

    await fs.promises.copyFile(sourcePath, filePath);
    return { saved: true, filePath };
});

function escHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
function escCsv(s) {
    return `"${String(s ?? "").replace(/"/g, '""')}"`;
}
function buildExportText(view, plainText, rows, title) {
    const head = title ? `${title}\n\n` : "";
    if (view === "diarize" && rows.length) {
        return head + rows.map((r) => `${r.speaker}: ${r.text}`).join("\n\n");
    }
    return head + (plainText || "");
}
function buildExportCsv(view, plainText, rows) {
    if (view === "diarize" && rows.length) {
        return (
            "Speaker,Text\n" +
            rows.map((r) => `${escCsv(r.speaker)},${escCsv(r.text)}`).join("\n")
        );
    }
    const lines = (plainText || "").split(/\n+/).filter((l) => l.trim());
    return "Text\n" + lines.map((l) => escCsv(l)).join("\n");
}
function buildExportHtml(view, plainText, rows, title) {
    const style =
        "body{font-family:'Segoe UI',Arial,sans-serif;color:#1F2540;line-height:1.6;padding:32px;}" +
        "h1{font-size:20px;margin:0 0 18px;}" +
        ".row{margin-bottom:14px;}" +
        ".spk{font-weight:bold;color:#2E6DBE;margin-bottom:2px;}" +
        "p{margin:4px 0;white-space:pre-wrap;}";
    let body;
    if (view === "diarize" && rows.length) {
        body = rows
            .map(
                (r) =>
                    `<div class="row"><div class="spk">${escHtml(
                        r.speaker,
                    )}</div><p>${escHtml(r.text)}</p></div>`,
            )
            .join("");
    } else {
        body = `<p>${escHtml(plainText || "")}</p>`;
    }
    return (
        `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>` +
        (title ? `<h1>${escHtml(title)}</h1>` : "") +
        body +
        "</body></html>"
    );
}

ipcMain.handle("export-transcript", async(_event, payload = {}) => {
    const { plainText, diarized, view, title, defaultName } = payload;
    const rows = Array.isArray(diarized) ? diarized : [];
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: "Save Transcript",
        defaultPath: defaultName || "ThreadNotes_Transcript.txt",
        filters: [
            { name: "Text", extensions: ["txt"] },
            { name: "CSV (Excel)", extensions: ["csv"] },
            { name: "Word Document", extensions: ["doc"] },
            { name: "PDF", extensions: ["pdf"] },
        ],
    });
    if (canceled || !filePath) return { saved: false };

    const ext = path.extname(filePath).toLowerCase();
    try {
        if (ext === ".pdf") {
            const html = buildExportHtml(view, plainText, rows, title);
            const tmp = path.join(app.getPath("temp"), `tn-export-${Date.now()}.html`);
            await fs.promises.writeFile(tmp, html, "utf-8");
            const pdfWin = new BrowserWindow({
                show: false,
                webPreferences: { offscreen: true },
            });
            try {
                await pdfWin.loadFile(tmp);
                const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
                await fs.promises.writeFile(filePath, pdf);
            } finally {
                pdfWin.destroy();
                fs.promises.unlink(tmp).catch(() => {});
            }
        } else if (ext === ".csv") {
            await fs.promises.writeFile(filePath, "﻿" + buildExportCsv(view, plainText, rows), "utf-8");
        } else if (ext === ".doc") {
            await fs.promises.writeFile(filePath, buildExportHtml(view, plainText, rows, title), "utf-8");
        } else {
            await fs.promises.writeFile(filePath, buildExportText(view, plainText, rows, title), "utf-8");
        }
        return { saved: true, filePath };
    } catch (err) {
        return { saved: false, reason: String(err && err.message ? err.message : err) };
    }
});

ipcMain.handle("rename-transcript-file", async(_event, { oldPath, newBaseName } = {}) => {
    if (!oldPath || !newBaseName) return { renamed: false };

    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath) || ".txt";
    const safeBase = String(newBaseName).replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 120) || "Transcript";
    const newPath = path.join(dir, `${safeBase}${ext}`);

    if (newPath === oldPath) return { renamed: true, filePath: oldPath };

    try {
        if (!fs.existsSync(oldPath)) return { renamed: false, reason: "missing" };
        await fs.promises.rename(oldPath, newPath);
        return { renamed: true, filePath: newPath };
    } catch (err) {
        return { renamed: false, reason: String(err && err.message ? err.message : err) };
    }
});

function getLocalTranscriptsDirectory() {
    // Keep transcripts in the app's own per-user data dir (AppData\Roaming\
    // ThreadNotes\Transcripts). Do NOT use Documents: Windows OneDrive "Known
    // Folder Move" redirects Documents into OneDrive and syncs it to the cloud —
    // which would break the local-only promise. AppData is never OneDrive-synced,
    // never touched by the installer, and survives reinstalls.
    const dir = path.join(app.getPath("userData"), "Transcripts");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

ipcMain.handle("save-transcript-local", async(_event, payload = {}) => {
    const dir = getLocalTranscriptsDirectory();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rawBase = (payload.baseName || "ThreadNotes-Transcript")
        .toString()
        .replace(/[^\w.-]+/g, "_")
        .slice(0, 80);

    const data = payload.data ?? payload;
    const asText = typeof data === "string";
    const ext = asText ? (payload.extension || "txt") : "json";
    const fileName = `${rawBase}-${stamp}.${ext}`;
    const filePath = path.join(dir, fileName);

    const contents = asText ? data : JSON.stringify(data, null, 2);
    await fs.promises.writeFile(filePath, contents, "utf-8");

    return { saved: true, filePath };
});

const audioBytesWritten = new Map();

ipcMain.handle("audio-file-create", async() => {
    const filePath = createRecordingFilePath();
    const writeStream = fs.createWriteStream(filePath, { flags: "a" });
    audioWriteStreams.set(filePath, writeStream);
    audioBytesWritten.set(filePath, 0);
    console.log("[Recorder/main] audio-file-create → absolute path:", filePath);
    return filePath;
});

ipcMain.handle("audio-file-append", async(_event, filePath, chunk) => {
    const writeStream = audioWriteStreams.get(filePath);
    if (!writeStream) {
        console.warn("[Recorder/main] audio-file-append: NO active stream for", filePath);
        throw new Error(`No active audio write stream found for ${filePath}`);
    }

    const buffer = Buffer.from(chunk);
    return new Promise((resolve, reject) => {
        writeStream.write(buffer, (err) => {
            if (err) {
                console.error("[Recorder/main] write error:", err);
                return reject(err);
            }
            const total = (audioBytesWritten.get(filePath) || 0) + buffer.length;
            audioBytesWritten.set(filePath, total);
            console.log(
                `[Recorder/main] appended ${buffer.length} bytes (total ${total}) → ${filePath}`,
            );
            resolve(true);
        });
    });
});

ipcMain.handle("audio-file-close", async(_event, filePath) => {
    const writeStream = audioWriteStreams.get(filePath);
    if (!writeStream) {
        console.warn("[Recorder/main] audio-file-close: no stream for", filePath);
        return false;
    }

    return new Promise((resolve) => {
        const finalize = () => {
            audioWriteStreams.delete(filePath);
            let sizeOnDisk = 0;
            try {
                sizeOnDisk = fs.statSync(filePath).size;
            } catch (e) {
                console.warn("[Recorder/main] stat failed after close:", e);
            }
            console.log(
                `[Recorder/main] audio-file-close → ${filePath} | bytes appended: ${
                    audioBytesWritten.get(filePath) || 0
                } | size on disk: ${sizeOnDisk}`,
            );
            audioBytesWritten.delete(filePath);
            resolve(true);
        };
        writeStream.once("close", finalize);
        writeStream.once("error", (err) => {
            console.warn("[Recorder/main] write stream error on close:", err);
            finalize();
        });
        writeStream.end();
    });
});

// Persist an UPLOADED file's audio into the recordings dir as a small ogg and
// return a durable media:// URL (so the audio plays in MyMeetings later).
// Unlike remux-audio (live webm only) this auto-detects the input format.
ipcMain.handle("persist-upload-audio", async(event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Upload file not found: ${filePath}`);
    }
    const recordingsDir = getRecordingsDirectory();
    const fileName = `upload-${Date.now()}.ogg`;
    const outputPath = path.join(recordingsDir, fileName);
    await runFfmpeg(
        [
            "-y",
            "-i", filePath,
            "-vn", "-c:a", "libopus", "-b:a", "32k",
            outputPath,
        ],
        (pct) => {
            try {
                event.sender.send("upload-progress", pct);
            } catch {}
        },
    );
    return {
        outputPath,
        fileName,
        mediaUrl: `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(fileName)}`,
    };
});

ipcMain.handle("remux-audio", async(event, filePath, totalDurationSec) => {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Recording file not found for remux: ${filePath}`);
    }
    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/\.[^.]+$/, "");
    const outputPath = path.join(dir, `${base}-final.ogg`);

    await runFfmpeg(
        [
            "-y",
            "-fflags", "+genpts+discardcorrupt",
            "-err_detect", "ignore_err",
            "-f", "webm",
            "-i", filePath,
            "-vn", "-c:a", "libopus", "-b:a", "32k",
            outputPath,
        ],
        (pct) => {
            try {
                event.sender.send("save-progress", pct);
            } catch {}
        },
        totalDurationSec,
    );

    const fileName = path.basename(outputPath);
    const sizeOnDisk = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    console.log(
        `[Recorder/main] remux-audio → ${outputPath} | size: ${sizeOnDisk} bytes`,
    );
    return {
        outputPath,
        fileName,
        mediaUrl: `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(fileName)}`,
    };
});

const SEGMENT_SECONDS = 1400;

ipcMain.handle("audio-compress-and-read", async(_event, filePath, segmentSeconds) => {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Recording file not found: ${filePath}`);
    }
    if (fs.statSync(filePath).size === 0) {
        throw new Error(`Recording file is empty (0 bytes): ${filePath}`);
    }

    // Chunk length: diarize can take large chunks; gpt-4o-transcribe has a much
    // smaller audio-token limit, so transcription passes a shorter value.
    const seg =
        Number(segmentSeconds) > 0 ? Number(segmentSeconds) : SEGMENT_SECONDS;

    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/\.[^.]+$/, "");
    const outPattern = path.join(dir, `${base}-chunk-%03d.ogg`);

    const isWebm = filePath.toLowerCase().endsWith(".webm");

    const buildArgs = (recover) => [
        "-y",
        "-fflags", "+genpts+discardcorrupt",
        "-err_detect", "ignore_err",
        ...(recover ? ["-analyzeduration", "100M", "-probesize", "100M"] : []),
        ...(isWebm && !recover ? ["-f", "webm"] : []),
        "-i", filePath,
        "-vn", "-ar", "16000", "-ac", "1", "-c:a", "libopus", "-b:a", "24k",
        "-f", "segment", "-segment_time", String(seg),
        outPattern,
    ];

    try {
        await runFfmpeg(buildArgs(false));
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/does not contain any stream|Output file is empty/i.test(msg)) {
            throw new Error(
                "This file has no audio track to transcribe. Please upload a file that contains audio.",
            );
        }
        if (/EBML header parsing failed|Invalid data found|error opening input/i.test(msg)) {
            console.warn("[Recorder/main] primary decode failed, attempting recovery pass:", msg);
            try {
                await runFfmpeg(buildArgs(true));
            } catch (err2) {
                throw new Error(
                    "This recording file is corrupted and could not be read. Please record again — if it keeps happening, disconnect/reconnect your microphone before recording.",
                );
            }
        } else {
            throw err;
        }
    }

    const produced = (await fs.promises.readdir(dir))
        .filter((f) => f.startsWith(`${base}-chunk-`) && f.endsWith(".ogg"))
        .sort();

    const chunks = [];
    for (const f of produced) {
        const full = path.join(dir, f);
        const data = await fs.promises.readFile(full);
        if (data.byteLength > 0) {
            chunks.push({
                buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
                name: f,
            });
        }
        fs.promises.unlink(full).catch(() => {});
    }

    if (chunks.length === 0) {
        throw new Error(
            "FFmpeg produced no usable audio chunks — the recording may be empty or corrupt.",
        );
    }
    return { chunks, segmentSeconds: seg, mimeType: "audio/ogg" };
});

ipcMain.handle("get-desktop-source-id", async() => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    return sources[0].id;
});