/**
 * Typecase desktop app. Imports the same parser library as the CLI —
 * no duplicated parsing logic. Mac-first: hidden-inset title bar with
 * traffic lights floating over the translucent sidebar; sensible
 * fallbacks elsewhere.
 */

import { app, BrowserWindow, ipcMain, shell, nativeTheme } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discover } from "../scripts/lib/discover.mjs";
import { readLock, diffAgainstLock, LOCKFILE, CHANGELOG } from "../scripts/lib/lockfile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workdir = process.env.TYPECASE_CWD ?? process.cwd();
const isMac = process.platform === "darwin";

let win;
const watchers = [];

function collectData() {
  const data = discover({ cwd: workdir });
  const lockPath = path.join(workdir, LOCKFILE);
  const lock = readLock(lockPath);
  const changes = lock ? diffAgainstLock(lock, data) : [];
  const changelogPath = path.join(workdir, CHANGELOG);
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  return { ...data, lock, lockPath, changes, changelog, platform: process.platform };
}

function watchRoots(data) {
  for (const w of watchers.splice(0)) w.close();
  for (const root of data.roots.filter((r) => r.exists)) {
    try {
      const w = watch(root.dir, { recursive: true }, () => {
        clearTimeout(watchRoots.t);
        watchRoots.t = setTimeout(() => win?.webContents.send("skills-changed"), 400);
      });
      watchers.push(w);
    } catch {
      // recursive watch unsupported on some platforms/dirs — skip
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151417" : "#f3f2f0",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 20, y: 18 },
    ...(isMac ? { vibrancy: "sidebar", visualEffectState: "active" } : {}),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.loadFile(path.join(here, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
}

ipcMain.handle("typecase:data", () => {
  const data = collectData();
  watchRoots(data);
  return data;
});

ipcMain.handle("typecase:raw", (_e, file) => {
  return readFileSync(file, "utf8");
});

ipcMain.handle("typecase:reveal", (_e, file) => {
  shell.showItemInFolder(file);
});

ipcMain.handle("typecase:open-editor", (_e, file) => {
  // Cursor first, then VS Code, then the OS default.
  const candidates = ["cursor", "code"];
  const tryNext = (i) => {
    if (i >= candidates.length) {
      shell.openPath(file);
      return;
    }
    const child = spawn(candidates[i], [file], { detached: true, stdio: "ignore" });
    child.on("error", () => tryNext(i + 1));
    child.unref();
  };
  tryNext(0);
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
