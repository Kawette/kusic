// ─── slskd Process Manager ──────────────────────────────────
// Windows only - version locked to avoid breaking changes

import { spawn, execFile, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { app, net as electronNet } from "electron";
import { SlskdConfig } from "./SlskdConfig.js";
import { SlskdAPI } from "./SlskdAPI.js";
import type { SlskdStatus, SoulseekConfig } from "../../types.js";

const SLSKD_VERSION = "0.24.5";
const WEB_PORT = 5030;
const LISTEN_PORT = 50300;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const READY_TIMEOUT = 30_000;

type State = "stopped" | "starting" | "running" | "stopping";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function processImageName(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], (err, stdout) =>
      resolve(err ? "" : stdout.split(",")[0]?.replace(/"/g, "").trim().toLowerCase() || ""),
    );
  });
}

/** Extract a zip with Windows' built-in bsdtar (rejects absolute and ".." paths). */
function extractZip(zipPath: string, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return new Promise((resolve, reject) => {
    execFile(tar, ["-xf", zipPath, "-C", dir], { windowsHide: true }, (err, _out, stderr) =>
      err ? reject(new Error(`Extraction impossible : ${stderr || err.message}`)) : resolve(),
    );
  });
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true }, (err) => {
      if (err) console.warn(`[slskd] taskkill ${pid}:`, err.message);
      resolve();
    });
  });
}

export class SlskdManager {
  private state: State = "stopped";
  private child: ChildProcess | null = null;
  private client: SlskdAPI | null = null;
  private startPromise: Promise<SlskdAPI> | null = null;
  private stopPromise: Promise<void> | null = null;
  /** Set when Stop is clicked while slskd is starting */
  private stopRequested = false;
  /** Folder slskd saves downloads to, as configured when it was started */
  downloadsDir = "";
  /** Last error reported by slskd, shown in the settings */
  lastError = "";
  /** Called when the process exits or becomes ready */
  onStateChange: () => void = () => {};

  private resourcesPath = path.join(app.getPath("userData"), "slskd");
  private binDir = path.join(
    this.resourcesPath,
    "bin",
    process.arch === "arm64" ? "win-arm64" : "win-x64",
  );
  private binaryPath = path.join(this.binDir, "slskd.exe");
  private configPath = path.join(this.resourcesPath, "slskd.yml");
  private dataPath = path.join(this.resourcesPath, "data");
  private incompletePath = path.join(this.resourcesPath, "incomplete");
  private pidPath = path.join(this.resourcesPath, "slskd.pid");
  private versionPath = path.join(this.resourcesPath, "version.json");

  get isRunning(): boolean {
    return this.state === "running";
  }

  /** The API client while slskd is running, else null. */
  get api(): SlskdAPI | null {
    return this.isRunning ? this.client : null;
  }

  isPlatformSupported(): boolean {
    return process.platform === "win32";
  }

  // ─── Binary ───────────────────────────────────────────────

  getVersionInfo() {
    const installed = this.isPlatformSupported() && fs.existsSync(this.binaryPath);
    let installedVersion: string | null = null;
    try {
      installedVersion = JSON.parse(fs.readFileSync(this.versionPath, "utf8")).version;
    } catch {
      // Unknown version
    }
    return {
      version: SLSKD_VERSION,
      installed,
      installedVersion,
      updateAvailable: installed && installedVersion !== SLSKD_VERSION,
    };
  }

  isBinaryInstalled(): boolean {
    return this.getVersionInfo().installed;
  }

  async downloadBinary(onProgress: (percent: number) => void = () => {}): Promise<void> {
    if (!this.isPlatformSupported()) {
      throw new Error("Seul Windows est supporté actuellement.");
    }
    if (this.state !== "stopped") {
      throw new Error("Arrêtez slskd avant de le mettre à jour");
    }

    const target = process.arch === "arm64" ? "win-arm64" : "win-x64";
    const url = `https://github.com/slskd/slskd/releases/download/${SLSKD_VERSION}/slskd-${SLSKD_VERSION}-${target}.zip`;
    const zipPath = path.join(this.resourcesPath, "slskd.zip");
    const extractDir = `${this.binDir}.new`;
    fs.mkdirSync(this.resourcesPath, { recursive: true });

    try {
      const response = await electronNet.fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) {
        throw new Error(`Téléchargement impossible (HTTP ${response.status})`);
      }

      const total = Number(response.headers.get("content-length")) || 0;
      let received = 0;
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (total) onProgress(Math.round((received / total) * 100));
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as import("stream/web").ReadableStream),
        progress,
        fs.createWriteStream(zipPath),
      );

      // Extract next to the current install, then swap
      fs.rmSync(extractDir, { recursive: true, force: true });
      await extractZip(zipPath, extractDir);
      if (!fs.existsSync(path.join(extractDir, "slskd.exe"))) {
        throw new Error("Archive slskd invalide (slskd.exe absent)");
      }
      // Swap without ever leaving the install without a binary
      const oldDir = `${this.binDir}.old`;
      fs.rmSync(oldDir, { recursive: true, force: true });
      if (fs.existsSync(this.binDir)) fs.renameSync(this.binDir, oldDir);
      fs.renameSync(extractDir, this.binDir);
      fs.rmSync(oldDir, { recursive: true, force: true });

      fs.writeFileSync(
        this.versionPath,
        JSON.stringify({
          version: SLSKD_VERSION,
          installedAt: new Date().toISOString(),
          arch: process.arch,
        }),
        "utf8",
      );
    } finally {
      fs.rmSync(zipPath, { force: true });
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  // ─── Process lifecycle ────────────────────────────────────

  /** Start slskd; concurrent calls share the same start. */
  start(options: SoulseekConfig, apiKey: string): Promise<SlskdAPI> {
    if (this.state === "running" && this.client) return Promise.resolve(this.client);
    this.startPromise ??= this.doStart(options, apiKey).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(options: SoulseekConfig, apiKey: string): Promise<SlskdAPI> {
    if (!options.username || !options.password) {
      throw new Error("Configurez vos identifiants Soulseek dans les paramètres");
    }
    if (!options.libraryPath) {
      throw new Error("Configurez le dossier de votre bibliothèque dans les paramètres");
    }
    if (!this.isBinaryInstalled()) {
      throw new Error("slskd n'est pas installé. Téléchargez-le dans les paramètres.");
    }
    if (this.stopPromise) await this.stopPromise;

    this.state = "starting";
    this.stopRequested = false;
    this.lastError = "";
    this.onStateChange();

    try {
      await this.killOrphan();
      if (await isPortInUse(WEB_PORT)) {
        throw new Error(`Le port ${WEB_PORT} est déjà utilisé par une autre application`);
      }
      if (this.stopRequested) throw new Error("Démarrage annulé");

      new SlskdConfig(this.configPath).generate({
        username: options.username,
        libraryPath: options.libraryPath,
        incompletePath: this.incompletePath,
        webPort: WEB_PORT,
        listenPort: LISTEN_PORT,
      });
      fs.mkdirSync(this.dataPath, { recursive: true });

      const child = this.spawnProcess(options.password, apiKey);
      const exited = new Promise<never>((_, reject) => {
        child.once("error", (err) => reject(err));
        child.once("exit", (code) =>
          reject(
            new Error(
              `slskd s'est arrêté au démarrage (code ${code})${this.lastError ? ` : ${this.lastError}` : ""}`,
            ),
          ),
        );
      });
      exited.catch(() => {}); // Handled by the race below

      const api = new SlskdAPI(BASE_URL, apiKey);
      await Promise.race([this.waitForReady(api), exited]);
      if (this.stopRequested) throw new Error("Démarrage annulé");

      this.client = api;
      this.downloadsDir = options.libraryPath;
      this.state = "running";
      this.onStateChange();
      return api;
    } catch (err) {
      if (!this.stopRequested) this.lastError ||= (err as Error).message;
      await this.stop({ force: true });
      throw err;
    }
  }

  private spawnProcess(password: string, apiKey: string): ChildProcess {
    const args = ["--config", this.configPath, "--app-dir", this.dataPath, "--no-logo"];
    console.log(`[slskd] Starting: ${this.binaryPath} ${args.join(" ")}`);

    const child = spawn(this.binaryPath, args, {
      cwd: this.resourcesPath,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        SLSKD_SLSK_PASSWORD: password,
        SLSKD_API_KEY: `role=Administrator;cidr=127.0.0.1/32,::1/128;${apiKey}`,
        // Replace the default slskd/slskd web login: only the API key is used
        SLSKD_USERNAME: "kusic",
        SLSKD_PASSWORD: apiKey,
      },
    });
    this.child = child;
    if (child.pid) fs.writeFileSync(this.pidPath, String(child.pid), "utf8");

    const onOutput = (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
        console.log("[slskd]", line);
        if (/\b(ERR|FTL|error|fail(ed)?|exception|invalid)\b/i.test(line)) {
          this.lastError = line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 300);
        }
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);

    const onGone = () => {
      // Ignore late exits of a previous process
      if (this.child !== child) return;
      this.child = null;
      this.client = null;
      this.state = "stopped";
      fs.rmSync(this.pidPath, { force: true });
      this.onStateChange();
    };
    child.on("exit", (code) => {
      console.log(`[slskd] Process exited with code ${code}`);
      onGone();
    });
    // Spawn failures (missing or quarantined exe) emit "error" without "exit"
    child.on("error", onGone);

    return child;
  }

  private async waitForReady(api: SlskdAPI): Promise<void> {
    for (const end = Date.now() + READY_TIMEOUT; Date.now() < end; ) {
      if (!this.child) throw new Error("slskd s'est arrêté au démarrage");
      if (await api.healthCheck()) return;
      await delay(500);
    }
    throw new Error("slskd ne répond pas (délai dépassé)");
  }

  /** Kill a slskd left running by a previous Kusic session. */
  private async killOrphan(): Promise<void> {
    if (!fs.existsSync(this.pidPath)) return;
    const pid = Number(fs.readFileSync(this.pidPath, "utf8"));
    fs.rmSync(this.pidPath, { force: true });
    if (!pid || (await processImageName(pid)) !== "slskd.exe") return;

    console.log(`[slskd] Killing orphan process ${pid}`);
    await killTree(pid);
    for (let i = 0; i < 20 && (await isPortInUse(WEB_PORT)); i++) await delay(250);
  }

  /** Stop slskd and wait for the process to exit. */
  stop({ force = false } = {}): Promise<void> {
    // Stop clicked during startup: the start sequence aborts itself
    if (this.state === "starting" && !force) this.stopRequested = true;
    const child = this.child;
    if (!child) {
      if (this.state !== "starting" || force) {
        this.state = "stopped";
        this.onStateChange();
      }
      return Promise.resolve();
    }

    this.stopPromise ??= (async () => {
      console.log("[slskd] Stopping process...");
      this.state = "stopping";
      this.client = null;
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      if (child.pid) await killTree(child.pid);
      await Promise.race([exited, delay(5000)]);
      if (this.child === child) {
        this.child = null;
        this.state = "stopped";
        fs.rmSync(this.pidPath, { force: true });
        this.onStateChange();
      }
    })().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  getAPI(): SlskdAPI {
    if (!this.api) throw new Error("slskd n'est pas démarré");
    return this.api;
  }

  async getStatus(): Promise<SlskdStatus> {
    if (this.state === "starting") {
      return { running: false, connected: false, starting: true };
    }
    const api = this.api;
    if (!api) {
      return { running: false, connected: false, lastError: this.lastError || undefined };
    }

    try {
      const { state = "", username } = await api.getServerState();
      const isConnected = state.includes("Connected");
      const isLoggedIn = state.includes("LoggedIn");
      return {
        running: true,
        connected: isConnected && isLoggedIn,
        connecting: isConnected && !isLoggedIn,
        username,
        state,
        lastError: this.lastError || undefined,
      };
    } catch {
      return { running: true, connected: false, state: "Démarrage..." };
    }
  }
}
