const {
    app,
    BrowserWindow,
    Menu,
    protocol,
    net,
    session,
    ipcMain,
    dialog,
    desktopCapturer, // <-- NAYA: Screen source uthane ke liye add kiya hai
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

let localAiProcess = null;

function spawnLocalAiEngine() {
    const isPackaged = app.isPackaged;
    const pythonExecutable = process.env.PYTHON_EXECUTABLE || "python";

    const packagedEnginePath = path.join(process.resourcesPath, "local_ai_engine.exe");
    const devEnginePath = path.join(__dirname, "..", "backend", "local_ai_engine.py");

    const command = isPackaged ? packagedEnginePath : pythonExecutable;
    const args = isPackaged ? [] : [devEnginePath];
    const cwd = isPackaged ? process.resourcesPath : path.join(__dirname, "..");

    try {
        localAiProcess = spawn(command, args, {
            cwd,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });

        localAiProcess.stdout.on("data", (data) => {
            console.log(`[Local AI] ${data.toString().trim()}`);
        });
        localAiProcess.stderr.on("data", (data) => {
            console.error(`[Local AI][ERR] ${data.toString().trim()}`);
        });
        localAiProcess.on("exit", (code, signal) => {
            console.log(
                `[Local AI] process exited with code=${code} signal=${signal}`,
            );
            localAiProcess = null;
        });
    } catch (error) {
        console.error("Failed to spawn local AI engine:", error);
        localAiProcess = null;
    }
}

function stopLocalAiEngine() {
    if (!localAiProcess) return;
    try {
        localAiProcess.kill("SIGTERM");
    } catch (error) {
        console.warn("Could not terminate local AI process gracefully:", error);
    }
    localAiProcess = null;
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

    spawnLocalAiEngine();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    closeAllAudioStreams();
    stopLocalAiEngine();
    if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
    stopLocalAiEngine();
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

// <-- NAYA: System audio / Screen share background permission handler
ipcMain.handle("get-desktop-source-id", async() => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    // Hum pehli screen ka id return kar rahe hain jisse system audio track ho sake
    return sources[0].id;
});