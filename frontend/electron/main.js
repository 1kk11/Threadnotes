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

function getFfmpegPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, "ffmpeg.exe")
        : path.join(__dirname, "..", "resources", "ffmpeg.exe");
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

protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
    },
}, ]);

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

    win.once("ready-to-show", () => win.show());

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

// Persist the diarized transcript to the user's local PC. The Cloud Vault is a
// stateless proxy and never stores transcripts — this is the only place they live.
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

ipcMain.handle("audio-file-create", async() => {
    const filePath = createRecordingFilePath();
    const writeStream = fs.createWriteStream(filePath, { flags: "a" });
    audioWriteStreams.set(filePath, writeStream);
    return filePath;
});

ipcMain.handle("audio-file-append", async(_event, filePath, chunk) => {
    const writeStream = audioWriteStreams.get(filePath);
    if (!writeStream) {
        throw new Error(`No active audio write stream found for ${filePath}`);
    }

    const buffer = Buffer.from(chunk);
    return new Promise((resolve, reject) => {
        writeStream.write(buffer, (err) => {
            if (err) return reject(err);
            resolve(true);
        });
    });
});

ipcMain.handle("audio-file-close", async(_event, filePath) => {
    const writeStream = audioWriteStreams.get(filePath);
    if (!writeStream) {
        return false;
    }

    return new Promise((resolve) => {
        writeStream.end(() => {
            audioWriteStreams.delete(filePath);
            resolve(true);
        });
    });
});

const SEGMENT_SECONDS = 9000;

ipcMain.handle("audio-compress-and-read", async(_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Recording file not found: ${filePath}`);
    }
    const ffmpeg = getFfmpegPath();
    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/\.[^.]+$/, "");
    const outPattern = path.join(dir, `${base}-chunk-%03d.ogg`);

    await new Promise((resolve, reject) => {
        const proc = spawn(ffmpeg, [
            "-y", "-i", filePath,
            "-vn", "-ar", "16000", "-ac", "1", "-c:a", "libopus", "-b:a", "24k",
            "-f", "segment", "-segment_time", String(SEGMENT_SECONDS),
            outPattern,
        ]);
        proc.on("error", reject);
        proc.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)),
        );
    });

    const produced = (await fs.promises.readdir(dir))
        .filter((f) => f.startsWith(`${base}-chunk-`) && f.endsWith(".ogg"))
        .sort();

    const chunks = [];
    for (const f of produced) {
        const full = path.join(dir, f);
        const data = await fs.promises.readFile(full);
        chunks.push({
            buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
            name: f,
        });
        fs.promises.unlink(full).catch(() => {});
    }

    if (chunks.length === 0) {
        throw new Error("ffmpeg produced no audio chunks.");
    }
    return { chunks, segmentSeconds: SEGMENT_SECONDS, mimeType: "audio/ogg" };
});

ipcMain.handle("get-desktop-source-id", async() => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    return sources[0].id;
});