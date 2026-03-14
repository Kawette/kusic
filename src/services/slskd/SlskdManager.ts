// ─── slskd Process Manager ──────────────────────────────────
// Windows only - version locked to avoid breaking changes

import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import https from "https";
import http from "http";
import { app } from "electron";
import { SlskdConfig } from "./SlskdConfig.js";
import { SlskdAPI } from "./SlskdAPI.js";
import type { SlskdStatus, SoulseekConfig } from "../../types.js";

const SLSKD_VERSION = "0.24.5";
const SUPPORTED_PLATFORM = "win32";

export class SlskdManager {
  private process: ChildProcess | null = null;
  private api: SlskdAPI | null = null;
  isRunning = false;
  private version = SLSKD_VERSION;

  private resourcesPath: string;
  private binaryPath: string | null;
  private configPath: string;
  private dataPath: string;
  private configManager: SlskdConfig;

  constructor() {
    this.resourcesPath = path.join(app.getPath("userData"), "slskd");
    this.binaryPath = this.getBinaryPath();
    this.configPath = path.join(this.resourcesPath, "slskd.yml");
    this.dataPath = path.join(this.resourcesPath, "data");
    this.configManager = new SlskdConfig(this.configPath);
  }

  isPlatformSupported(): boolean {
    return process.platform === SUPPORTED_PLATFORM;
  }

  private getBinaryPath(): string | null {
    if (process.platform !== "win32") {
      console.warn(
        "[slskd] Cette plateforme n'est pas supportée. Seul Windows est supporté.",
      );
      return null;
    }

    const arch = process.arch;
    const platformFolder = arch === "arm64" ? "win-arm64" : "win-x64";
    return path.join(this.resourcesPath, "bin", platformFolder, "slskd.exe");
  }

  private getDownloadUrl(): string {
    if (process.platform !== "win32") {
      throw new Error("Seul Windows est supporté actuellement");
    }

    const arch = process.arch;
    const platformSuffix = arch === "arm64" ? "win-arm64" : "win-x64";
    return `https://github.com/slskd/slskd/releases/download/${SLSKD_VERSION}/slskd-${SLSKD_VERSION}-${platformSuffix}.zip`;
  }

  getVersion(): string {
    return this.version;
  }

  isBinaryInstalled(): boolean {
    if (!this.binaryPath) return false;
    return fs.existsSync(this.binaryPath);
  }

  async downloadBinary(
    onProgress: (percent: number) => void = () => {},
  ): Promise<string> {
    if (!this.isPlatformSupported()) {
      throw new Error("Seul Windows est supporté actuellement.");
    }

    if (!this.binaryPath) {
      throw new Error("Impossible de déterminer le chemin du binaire");
    }

    const url = this.getDownloadUrl();
    const zipPath = path.join(this.resourcesPath, "slskd.zip");
    const binDir = path.dirname(this.binaryPath);

    fs.mkdirSync(binDir, { recursive: true });

    await this.downloadFile(url, zipPath, onProgress);

    const extract = require("extract-zip");
    await extract(zipPath, { dir: binDir });

    fs.unlinkSync(zipPath);

    const versionFile = path.join(this.resourcesPath, "version.json");
    fs.writeFileSync(
      versionFile,
      JSON.stringify({
        version: SLSKD_VERSION,
        installedAt: new Date().toISOString(),
        platform: "win32",
        arch: process.arch,
      }),
      "utf8",
    );

    return this.binaryPath;
  }

  private downloadFile(
    url: string,
    destPath: string,
    onProgress: (percent: number) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const protocol = url.startsWith("https") ? https : http;

      const request = protocol.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          fs.unlinkSync(destPath);
          this.downloadFile(response.headers.location!, destPath, onProgress)
            .then(resolve)
            .catch(reject);
          return;
        }

        const totalSize = parseInt(
          response.headers["content-length"] || "0",
          10,
        );
        let downloadedSize = 0;

        response.on("data", (chunk: Buffer) => {
          downloadedSize += chunk.length;
          if (totalSize) {
            onProgress(Math.round((downloadedSize / totalSize) * 100));
          }
        });

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          resolve(destPath);
        });
      });

      request.on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
  }

  async start(options: SoulseekConfig): Promise<SlskdAPI> {
    if (this.isRunning) {
      console.log("[slskd] Already running");
      return this.api!;
    }

    if (!options.username || !options.password) {
      throw new Error("Soulseek username and password are required");
    }
    if (!options.libraryPath) {
      throw new Error("Library path is required");
    }

    if (!this.isBinaryInstalled() || !this.binaryPath) {
      throw new Error("slskd binary not found. Please download it first.");
    }

    this.configManager.generate({
      username: options.username,
      password: options.password,
      libraryPath: options.libraryPath,
      webPort: 5030,
      listenPort: 50300,
    });

    fs.mkdirSync(this.dataPath, { recursive: true });

    return new Promise((resolve, reject) => {
      const args = [
        "--config",
        this.configPath,
        "--app-dir",
        this.dataPath,
        "--no-logo",
      ];

      console.log(`[slskd] Starting: ${this.binaryPath} ${args.join(" ")}`);

      this.process = spawn(this.binaryPath!, args, {
        cwd: this.resourcesPath,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        console.log("[slskd]", data.toString().trim());
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        console.error("[slskd:err]", data.toString().trim());
      });

      this.process.on("error", (err) => {
        console.error("[slskd] Process error:", err);
        this.isRunning = false;
        reject(err);
      });

      this.process.on("close", (code) => {
        console.log(`[slskd] Process exited with code ${code}`);
        this.isRunning = false;
        this.process = null;
      });

      this.waitForReady()
        .then(() => {
          this.isRunning = true;
          this.api = new SlskdAPI("http://localhost:5030");
          resolve(this.api);
        })
        .catch((err) => {
          this.stop();
          reject(new Error(`slskd failed to start: ${err.message}`));
        });
    });
  }

  private async waitForReady(
    maxAttempts = 30,
    interval = 1000,
  ): Promise<boolean> {
    const tempApi = new SlskdAPI("http://localhost:5030");

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const isReady = await tempApi.healthCheck();
        if (isReady) {
          console.log("[slskd] API is ready");
          return true;
        }
      } catch {
        // Ignore errors during startup
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error("Timeout waiting for slskd to start");
  }

  stop(): void {
    if (this.process) {
      console.log("[slskd] Stopping process...");

      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(this.process.pid), "/f", "/t"]);
      } else {
        this.process.kill("SIGTERM");
      }

      this.process = null;
      this.isRunning = false;
      this.api = null;
    }
  }

  getAPI(): SlskdAPI {
    if (!this.api) {
      throw new Error("slskd is not running");
    }
    return this.api;
  }

  async getStatus(): Promise<SlskdStatus> {
    if (!this.isRunning || !this.api) {
      return { running: false, connected: false };
    }

    try {
      const state = await this.api.getServerState();
      const stateStr = state.state || "";
      const isConnected = stateStr.includes("Connected");
      const isLoggedIn = stateStr.includes("LoggedIn");

      return {
        running: true,
        connected: isConnected && isLoggedIn,
        connecting: isConnected && !isLoggedIn,
        username: state.username,
        state: stateStr,
      };
    } catch {
      return { running: true, connected: false, state: "Démarrage..." };
    }
  }
}
