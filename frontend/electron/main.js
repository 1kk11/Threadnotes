const {
  app,
  BrowserWindow,
  Menu,
  protocol,
  net,
  session,
  ipcMain,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const isDev = !app.isPackaged;
const DEV_URL = "http://localhost:3000";
const OUT_DIR = path.join(__dirname, "..", "out");

const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://local/`;

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
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("save-transcript", async (_event, { content, defaultName }) => {
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
