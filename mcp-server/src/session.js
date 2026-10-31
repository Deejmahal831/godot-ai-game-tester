import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge.js";
import { Recorder } from "./recorder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADDON_DIR_NAME = "ai_game_tester";
const AUTOLOAD_NAME = "AiGameTester";
const AUTOLOAD_LINE = `${AUTOLOAD_NAME}="*res://addons/${ADDON_DIR_NAME}/ai_test_server.gd"`;
const BACKUP_SUFFIX = ".ai-tester-backup";
const LOG_MAX_LINES = 4000;

/** Locations checked for a Godot executable when GODOT_PATH isn't set. */
const GODOT_SEARCH_GLOBS = [
  "C:\\dev",
  path.join(os.homedir(), "Downloads"),
  "C:\\Program Files\\Godot",
  "C:\\godot",
];

export function findGodot(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.GODOT_PATH) candidates.push(process.env.GODOT_PATH);
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  if (candidates.length > 0 && !process.env.GODOT_PATH) {
    throw new Error(`Godot executable not found at: ${candidates[0]}`);
  }
  // Search common locations for a Godot 4 binary (prefer console builds on
  // Windows so stdout/stderr are captured reliably).
  const found = [];
  for (const dir of GODOT_SEARCH_GLOBS) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (/godot.*\.exe$/i.test(name) || /^godot[^.]*$/i.test(name)) {
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).isFile()) found.push(full);
        } catch {}
      }
    }
  }
  if (found.length === 0) {
    throw new Error(
      "Could not find a Godot executable. Set the GODOT_PATH environment variable or pass godot_path to launch_game."
    );
  }
  found.sort((a, b) => {
    const consoleBias = (p) => (/console/i.test(p) ? -1 : 0);
    return consoleBias(a) - consoleBias(b) || b.localeCompare(a);
  });
  return found[0];
}

function projectFile(projectPath) {
  return path.join(projectPath, "project.godot");
}

// Background launches: Godot's no_focus window flag keeps the game window from
// stealing focus from whatever the user is working in. Input still arrives -
// the bridge injects events inside the game, not through OS focus. Set
// GODOT_TESTER_FOREGROUND=1 (or pass background: false) to get the old
// behavior, e.g. to click into and play a test window by hand.
const NO_FOCUS_KEY = "window/size/no_focus";

function defaultBackground() {
  return !/^(1|true|yes)$/i.test(process.env.GODOT_TESTER_FOREGROUND ?? "");
}

// Second-monitor launches: test windows open on a screen other than the
// primary one, borderless, so they stay off the screen the user works on.
// GODOT_TESTER_SCREEN picks the Godot screen index; "off" (or "none") keeps
// the old behavior. Unset = auto: the first non-primary monitor, if any.
// Godot numbers screens in the same order as Windows' Screen.AllScreens
// (verified on a 2-monitor setup), so auto asks PowerShell once and caches it.
const BORDERLESS_KEY = "window/size/borderless";
let autoScreenCache;

function detectSecondaryScreen() {
  if (autoScreenCache !== undefined) return autoScreenCache;
  autoScreenCache = null;
  if (process.platform !== "win32") return autoScreenCache;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.Primary }"],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    const flags = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const idx = flags.findIndex((f) => /^false$/i.test(f));
    if (flags.length > 1 && idx !== -1) autoScreenCache = idx;
  } catch {
    // No PowerShell or no WinForms: stay on the default screen.
  }
  return autoScreenCache;
}

function pickTestScreen() {
  const env = (process.env.GODOT_TESTER_SCREEN ?? "").trim();
  if (/^(off|none|no|false)$/i.test(env)) return null;
  if (/^\d+$/.test(env)) return Number(env);
  return detectSecondaryScreen();
}

/** Set (or override) [display] keys in the patched file, e.g. no_focus=true. */
function applyDisplaySettings(lines, settings) {
  const keys = Object.keys(settings);
  if (keys.length === 0) return lines;
  const kept = [];
  let section = "";
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("[") && t.endsWith("]")) section = t;
    // Drop any existing line for a key we set, so ours is the only one.
    if (section === "[display]" && keys.some((k) => t.startsWith(k + "="))) continue;
    kept.push(l);
  }
  const added = keys.map((k) => `${k}=${settings[k]}`);
  const displayIdx = kept.findIndex((l) => l.trim() === "[display]");
  if (displayIdx !== -1) {
    kept.splice(displayIdx + 1, 0, "", ...added);
  } else {
    kept.push("", "[display]", "", ...added);
  }
  return kept;
}

/** Add our autoload to project.godot, backing up the original first. */
function patchProject(projectPath, { background = defaultBackground(), otherScreen = false } = {}) {
  const pf = projectFile(projectPath);
  const backup = pf + BACKUP_SUFFIX;
  // A leftover backup means a previous session crashed mid-run; restore it
  // so we patch a clean file.
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, pf);
    fs.unlinkSync(backup);
  }
  const original = fs.readFileSync(pf, "utf8");
  if (original.includes(AUTOLOAD_LINE)) return; // already patched somehow
  fs.copyFileSync(pf, backup);
  let lines = original.split(/\r?\n/);
  const display = {};
  if (background) display[NO_FOCUS_KEY] = "true";
  if (otherScreen) display[BORDERLESS_KEY] = "true";
  lines = applyDisplaySettings(lines, display);
  const autoloadIdx = lines.findIndex((l) => l.trim() === "[autoload]");
  if (autoloadIdx !== -1) {
    lines.splice(autoloadIdx + 1, 0, "", AUTOLOAD_LINE);
  } else {
    lines.push("", "[autoload]", "", AUTOLOAD_LINE);
  }
  fs.writeFileSync(pf, lines.join("\n"));
}

function restoreProject(projectPath) {
  const pf = projectFile(projectPath);
  const backup = pf + BACKUP_SUFFIX;
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, pf);
    fs.unlinkSync(backup);
  }
}

function injectAddon(projectPath) {
  const src = path.resolve(__dirname, "..", "..", "addon", ADDON_DIR_NAME, "ai_test_server.gd");
  if (!fs.existsSync(src)) {
    throw new Error(`Addon script not found at ${src} — is the repo intact?`);
  }
  const destDir = path.join(projectPath, "addons", ADDON_DIR_NAME);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, "ai_test_server.gd"));
}

function removeAddon(projectPath) {
  const destDir = path.join(projectPath, "addons", ADDON_DIR_NAME);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  // Remove the addons/ dir too if we were the only thing in it.
  const addonsDir = path.join(projectPath, "addons");
  try {
    if (fs.existsSync(addonsDir) && fs.readdirSync(addonsDir).length === 0) {
      fs.rmdirSync(addonsDir);
    }
  } catch {}
}

export class GodotSession {
  constructor() {
    this.proc = null;
    this.bridge = null;
    this.projectPath = null;
    this.port = null;
    this.logs = [];
    this.exitInfo = null;
    this.recorder = new Recorder(this);
    this._autoRecord = false;
    this.snapshots = new Map(); // name -> snapshot blob (kept server-side, off the AI's context)
  }

  /** Capture a named state snapshot of the running game (optionally to a file). */
  async saveState(name, { includeAutoloads = false, savePath } = {}) {
    if (!name && !savePath) throw new Error("Provide a 'name' (or a save_path) for the state");
    const data = await this.send("snapshot", { include_autoloads: includeAutoloads });
    if (name) this.snapshots.set(name, data);
    if (savePath) {
      const abs = path.resolve(savePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(data));
    }
    return {
      name: name ?? null,
      scene: data.scene,
      node_count: data.count,
      bytes: JSON.stringify(data).length,
      saved_to: savePath ? path.resolve(savePath) : null,
    };
  }

  /** Restore a previously saved state by name or from a file. */
  async loadState({ name, path: filePath, reload = false } = {}) {
    let data;
    if (filePath) data = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
    else if (name) data = this.snapshots.get(name);
    if (!data) throw new Error(`No saved state named '${name}'${filePath ? ` (file: ${filePath})` : ""}`);
    if (reload) {
      await this.send("reload_scene", {});
      await this.send("wait", { frames: 3 });
    }
    const r = await this.send("restore", { data }, 20000);
    return { name: name ?? filePath, reloaded: reload, ...r };
  }

  listStates() {
    return [...this.snapshots.entries()].map(([name, d]) => ({ name, scene: d.scene, node_count: d.count }));
  }

  get running() {
    return this.proc !== null && this.exitInfo === null;
  }

  _pushLog(stream, text) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      this.logs.push({ t: new Date().toISOString(), stream, line });
    }
    if (this.logs.length > LOG_MAX_LINES) {
      this.logs.splice(0, this.logs.length - LOG_MAX_LINES);
    }
  }

  /**
   * Launch a Godot project windowed with the test bridge injected.
   * The project.godot patch is reverted as soon as the game has booted, so
   * the project on disk is only modified for a few seconds.
   */
  async launch({ projectPath, scene, godotPath, windowX, windowY, extraArgs = [], autoRecord = false, fpsCap, background }) {
    if (this.running) {
      throw new Error("A game is already running. Call stop_game first.");
    }
    const resolvedProject = path.resolve(projectPath);
    if (!fs.existsSync(projectFile(resolvedProject))) {
      throw new Error(`No project.godot found in ${resolvedProject}`);
    }
    const godot = findGodot(godotPath);
    const port = 9100 + Math.floor(Math.random() * 800);

    // An explicit window position wins over the second-monitor default.
    const hasPosition = windowX !== undefined && windowY !== undefined;
    const testScreen = hasPosition ? null : pickTestScreen();

    injectAddon(resolvedProject);
    patchProject(resolvedProject, {
      background: background ?? defaultBackground(),
      otherScreen: testScreen !== null,
    });

    this.projectPath = resolvedProject;
    this.port = port;
    this.logs = [];
    this.exitInfo = null;

    const args = ["--path", resolvedProject];
    if (scene) {
      let s = scene.replace(/\\/g, "/");
      if (!s.startsWith("res://")) s = "res://" + s.replace(/^\/+/, "");
      args.push(s);
    }
    if (hasPosition) {
      args.push("--position", `${windowX},${windowY}`);
    } else if (testScreen !== null) {
      args.push("--screen", String(testScreen));
    }
    args.push(...extraArgs, "--", `--ai-port=${port}`);
    if (fpsCap) args.push(`--ai-fps-cap=${fpsCap}`);

    this.proc = spawn(godot, args, {
      cwd: resolvedProject,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    this.proc.stdout.on("data", (d) => this._pushLog("out", d.toString("utf8")));
    this.proc.stderr.on("data", (d) => this._pushLog("err", d.toString("utf8")));
    this.proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal, at: new Date().toISOString() };
      restoreProject(resolvedProject);
      removeAddon(resolvedProject);
      if (this.bridge) this.bridge.close();
    });

    this.bridge = new Bridge(port);
    try {
      await this.bridge.connect(25000);
      await this.bridge.send("ping", {}, 10000);
    } catch (e) {
      const logTail = this.logs.slice(-30).map((l) => l.line).join("\n");
      await this.stop().catch(() => {});
      throw new Error(`Game launched but the test bridge never became reachable: ${e.message}\nRecent output:\n${logTail}`);
    } finally {
      // Boot is past the point where project.godot is read; restore it now so
      // the user's project is left untouched even while the game runs.
      restoreProject(resolvedProject);
    }

    const info = await this.bridge.send("info");
    this._autoRecord = autoRecord;
    if (autoRecord) {
      try {
        this.recorder.start(typeof autoRecord === "object" ? autoRecord : {});
      } catch {
        /* non-fatal */
      }
    }
    return { port, godot, pid: this.proc.pid, info, auto_recording: this.recorder.active };
  }

  async send(cmd, args = {}, timeoutMs) {
    if (!this.running || !this.bridge?.connected) {
      throw new Error("No game is running (or the bridge disconnected). Use launch_game first.");
    }
    return this.bridge.send(cmd, args, timeoutMs);
  }

  async stop() {
    const proc = this.proc;
    if (!proc) return { stopped: false, reason: "nothing running" };
    // Finalize an in-progress recording while frames are still in memory.
    let recording = null;
    if (this.recorder.active || this.recorder.frames.length > 0) {
      this.recorder.stopCapture();
      if (this._autoRecord && this.recorder.frames.length > 0) {
        try {
          recording = await this.recorder.encodeGif();
        } catch (e) {
          recording = { error: e.message };
        }
      }
    }
    if (this.bridge?.connected) {
      try {
        await this.bridge.send("quit", {}, 3000);
      } catch {}
    }
    const exited = await new Promise((resolve) => {
      if (this.exitInfo) return resolve(true);
      const timer = setTimeout(() => resolve(false), 4000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.bridge) this.bridge.close();
    if (this.projectPath) {
      restoreProject(this.projectPath);
      removeAddon(this.projectPath);
    }
    const exitInfo = this.exitInfo;
    this.proc = null;
    this.bridge = null;
    this._autoRecord = false;
    return { stopped: true, exit: exitInfo, recording };
  }

  status() {
    return {
      running: this.running,
      pid: this.proc?.pid ?? null,
      port: this.port,
      project: this.projectPath,
      bridge_connected: this.bridge?.connected ?? false,
      exit: this.exitInfo,
      recent_output: this.logs.slice(-15).map((l) => `[${l.stream}] ${l.line}`),
    };
  }

  getLogs({ tail = 100, errorsOnly = false } = {}) {
    let lines = this.logs;
    if (errorsOnly) {
      const isError = (l, i, arr) => {
        if (/SCRIPT ERROR|ERROR|WARNING|USER ERROR|Assertion/i.test(l.line)) return true;
        // Godot prints "   at: ..." continuation lines after errors.
        if (/^\s+at:/.test(l.line) && i > 0 && isErrorLine(arr[i - 1].line)) return true;
        return false;
      };
      const isErrorLine = (line) => /SCRIPT ERROR|ERROR|WARNING|USER ERROR/i.test(line);
      lines = lines.filter((l, i, arr) => isError(l, i, arr));
    }
    return lines.slice(-tail).map((l) => `${l.t} [${l.stream}] ${l.line}`);
  }
}

/** Recursively list .tscn files in a project (skips .godot and hidden dirs). */
export function listScenes(projectPath) {
  const root = path.resolve(projectPath);
  if (!fs.existsSync(projectFile(root))) {
    throw new Error(`No project.godot found in ${root}`);
  }
  const scenes = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".tscn")) {
        scenes.push("res://" + path.relative(root, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  // Flag the main scene so agents know the default entry point.
  let mainScene = null;
  try {
    const pg = fs.readFileSync(projectFile(root), "utf8");
    const m = pg.match(/run\/main_scene="([^"]+)"/);
    if (m) mainScene = m[1];
  } catch {}
  return { main_scene: mainScene, scenes: scenes.sort() };
}
