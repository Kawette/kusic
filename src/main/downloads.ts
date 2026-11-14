// ─── Download tracking ─────────────────────────────────────
// Remembers which playlist track each Soulseek download is for (persisted,
// so it survives restarts), polls slskd, and hands finished files to the
// library to be tagged and placed. Only downloads started from Kusic are
// processed, so old transfers never trigger anything.

import fs from "fs";
import path from "path";
import type { SlskdAPI } from "../services/slskd/index.js";
import type { Transfer } from "../types.js";
import { downloadsStore, type PendingDownload } from "./store.js";
import type { Library } from "./library/library.js";
import { listAudioFiles } from "./library/files.js";
import { slskdLocalPath } from "./library/naming.js";

const POLL_INTERVAL = 2000;
const MAX_ATTEMPTS = 10;
const STALE_AFTER = 7 * 24 * 60 * 60 * 1000;

export type DownloadEvent =
  | { type: "placed"; trackId: string; filePath: string }
  | { type: "conflict"; trackId: string }
  | { type: "error"; trackId: string; message: string };

const keyOf = (username: string, filename: string) => `${username}\u0000${filename}`;

export function isSucceeded(state: string): boolean {
  return /succeeded/i.test(state);
}

interface RawDownloads {
  username?: string;
  directories?: { files?: Partial<Transfer>[] }[];
}

function flattenTransfers(users: RawDownloads[]): Transfer[] {
  return users.flatMap((user) =>
    (user.directories || []).flatMap((dir) =>
      (dir.files || []).map((file) => ({
        username: user.username || "",
        id: file.id || "",
        filename: file.filename || "",
        state: file.state || "",
        size: file.size || 0,
        bytesTransferred: file.bytesTransferred || 0,
        percentComplete: file.percentComplete || 0,
        averageSpeed: file.averageSpeed || 0,
      })),
    ),
  );
}

export class DownloadTracker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private generation = 0;
  private polling: Promise<Transfer[]> | null = null;
  private latest: Transfer[] = [];

  constructor(
    private getApi: () => SlskdAPI | null,
    private library: Library,
    private libraryRoot: () => string,
    private onUpdate: (transfers: Transfer[]) => void,
    private onEvent: (event: DownloadEvent) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const loop = async () => {
      await this.refresh().catch(() => {});
      if (generation === this.generation) this.timer = setTimeout(loop, POLL_INTERVAL);
    };
    loop();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.latest = [];
    this.onUpdate([]);
  }

  get transfers(): Transfer[] {
    return this.latest;
  }

  register(username: string, filename: string, size: number, trackId: string): void {
    const pending = downloadsStore.get("pending");
    pending[keyOf(username, filename)] = {
      username,
      filename,
      size,
      trackId,
      requestedAt: Date.now(),
      attempts: 0,
    };
    downloadsStore.set("pending", pending);
  }

  forget(username: string, filename: string): void {
    const pending = downloadsStore.get("pending");
    delete pending[keyOf(username, filename)];
    downloadsStore.set("pending", pending);
  }

  /** Poll slskd now (concurrent callers share the same poll). */
  refresh(): Promise<Transfer[]> {
    this.polling ??= this.poll().finally(() => (this.polling = null));
    return this.polling;
  }

  private async poll(): Promise<Transfer[]> {
    const api = this.getApi();
    if (!api) return [];

    const pending = downloadsStore.get("pending");
    const transfers = flattenTransfers((await api.getDownloads()) as RawDownloads[]).map(
      (t) => ({ ...t, trackId: pending[keyOf(t.username, t.filename)]?.trackId }),
    );
    this.latest = transfers;
    this.onUpdate(transfers);

    await this.processFinished(transfers, pending);
    return transfers;
  }

  private async processFinished(
    transfers: Transfer[],
    pending: Record<string, PendingDownload>,
  ): Promise<void> {
    let changed = false;

    for (const t of transfers) {
      const key = keyOf(t.username, t.filename);
      const entry = pending[key];
      if (!entry || !isSucceeded(t.state) || entry.attempts >= MAX_ATTEMPTS) continue;

      changed = true;
      const filePath = await this.locate(t);
      if (!filePath) {
        // slskd may still be moving the file out of the incomplete folder
        entry.attempts++;
        if (entry.attempts >= MAX_ATTEMPTS) {
          entry.error = "Fichier téléchargé introuvable dans la bibliothèque";
          this.onEvent({ type: "error", trackId: entry.trackId, message: entry.error });
        }
        continue;
      }

      try {
        const result = await this.library.placeFile(filePath, entry.trackId);
        delete pending[key];
        this.onEvent(
          result.status === "placed"
            ? { type: "placed", trackId: entry.trackId, filePath: result.filePath }
            : { type: "conflict", trackId: entry.trackId },
        );
      } catch (err) {
        entry.attempts++;
        entry.error = (err as Error).message;
        if (entry.attempts >= MAX_ATTEMPTS) {
          this.onEvent({ type: "error", trackId: entry.trackId, message: entry.error });
        }
      }
    }

    // Forget requests whose transfer vanished from slskd long ago
    const known = new Set(transfers.map((t) => keyOf(t.username, t.filename)));
    for (const [key, entry] of Object.entries(pending)) {
      if (!known.has(key) && Date.now() - entry.requestedAt > STALE_AFTER) {
        delete pending[key];
        changed = true;
      }
    }

    if (changed) downloadsStore.set("pending", pending);
  }

  /** Local path of a finished download: where slskd puts it, else by name + size. */
  private async locate(t: Transfer): Promise<string | null> {
    const root = this.libraryRoot();
    if (!root) return null;
    const expected = slskdLocalPath(root, t.filename);
    const sizeMatches = (p: string) => !t.size || fs.statSync(p).size === t.size;
    if (fs.existsSync(expected) && sizeMatches(expected)) return expected;

    // slskd renames on collisions; fall back to the newest same-size file
    const stem = path.basename(expected, path.extname(expected)).toLowerCase();
    const candidates = (await listAudioFiles(root))
      .filter((p) => path.basename(p).toLowerCase().startsWith(stem) && sizeMatches(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] ?? null;
  }
}
