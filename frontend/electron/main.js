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
} = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const isDev = !app.isPackaged;

const audioWriteStreams = new Map();

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

function runFfmpeg(args) {
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
        proc.stderr.on("data", (d) => {
            stderr += d.toString();
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

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 940,
        minHeight: 640,
        icon: path.join(__dirname, "..", "build", "icon.ico"),
        backgroundColor: "#f8fafc",
        autoHideMenuBar: true,
        titleBarStyle: "hidden",
        titleBarOverlay: {
            color: "#EBF2FA",
            symbolColor: "#475569",
            height: 40,
        },
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    Menu.setApplicationMenu(null);

    win.once("ready-to-show", () => {
        win.maximize();
        win.show();
    });

    if (isDev) {
        win.loadURL(DEV_URL);
        win.webContents.openDevTools({ mode: "detach" });
    } else {
        win.loadURL(APP_ORIGIN);
    }

    return win;
}

app.whenReady().then(() => {
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

function getLocalTranscriptsDirectory() {
    const dir = path.join(app.getPath("documents"), "ThreadNotes");
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

ipcMain.handle("remux-audio", async(_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Recording file not found for remux: ${filePath}`);
    }
    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/\.[^.]+$/, "");
    const outputPath = path.join(dir, `${base}-final.ogg`);

    await runFfmpeg([
        "-y",
        "-fflags", "+genpts+discardcorrupt",
        "-err_detect", "ignore_err",
        "-f", "webm",
        "-i", filePath,
        "-vn", "-c:a", "libopus", "-b:a", "32k",
        outputPath,
    ]);

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

ipcMain.handle("audio-compress-and-read", async(_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Recording file not found: ${filePath}`);
    }
    if (fs.statSync(filePath).size === 0) {
        throw new Error(`Recording file is empty (0 bytes): ${filePath}`);
    }

    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/\.[^.]+$/, "");
    const outPattern = path.join(dir, `${base}-chunk-%03d.ogg`);

    const isWebm = filePath.toLowerCase().endsWith(".webm");
    try {
        await runFfmpeg([
            "-y",
            "-fflags", "+genpts+discardcorrupt",
            "-err_detect", "ignore_err",
            ...(isWebm ? ["-f", "webm"] : []),
            "-i", filePath,
            "-vn", "-ar", "16000", "-ac", "1", "-c:a", "libopus", "-b:a", "24k",
            "-f", "segment", "-segment_time", String(SEGMENT_SECONDS),
            outPattern,
        ]);
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/does not contain any stream|Output file is empty/i.test(msg)) {
            throw new Error(
                "This file has no audio track to transcribe. Please upload a file that contains audio.",
            );
        }
        throw err;
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
    return { chunks, segmentSeconds: SEGMENT_SECONDS, mimeType: "audio/ogg" };
});

ipcMain.handle("get-desktop-source-id", async() => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    return sources[0].id;
});