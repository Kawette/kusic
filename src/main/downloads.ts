// ─── Download tracking ─────────────────────────────────────
// Remembers which playlist track each Soulseek download is for (persisted,
// so it survives restarts), polls slskd, and hands finished files to the
// library to be tagged and placed. Only downloads started from Kusic are
// processed, so old transfers never trigger anything.

import fs from "fs";
import path from "path";
import type { SlskdAPI } from "../services/slskd/index.js";
import type { QueueEstimate, Transfer, UserPresence } from "../types.js";
import { downloadsStore, type PendingDownload } from "./store.js";
import type { Library } from "./library/library.js";
import { listAudioFiles } from "./library/files.js";
import { isInside, slskdLocalPath } from "./library/naming.js";
import { addQueueSample, estimateQueue, type QueueSample } from "./queue-estimate.js";

const POLL_INTERVAL = 2000;
const MAX_ATTEMPTS = 10;
const STALE_AFTER = 7 * 24 * 60 * 60 * 1000;
/** How often to ask a remote user for our place in their queue and their presence */
const REMOTE_QUEUE_INTERVAL = 60_000;
/**
 * slskd marks the downloads running when it closes as errored, then, a few
 * seconds after logging in to Soulseek again, requests them anew (new
 * transfers replacing the old ones). Until then and for this long after,
 * they are shown as resuming, not failed.
 */
const RESUME_GRACE = 60_000;
/** How often to check the Soulseek login while waiting for it (for RESUME_GRACE) */
const LOGIN_CHECK_INTERVAL = 10_000;

export type DownloadEvent =
  | { type: "placed"; trackId: string; filePath: string }
  | { type: "conflict"; trackId: string }
  | { type: "error"; trackId: string; message: string };

const keyOf = (username: string, filename: string) => `${username}\u0000${filename}`;

/** slskd times are UTC but may come without a time zone suffix. */
export function parseUtc(time: string): number {
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(time) ? time : `${time}Z`);
}

// Same predicate as the renderer's (no shared module between both sides)
export function isSucceeded(state: string): boolean {
  return /succeeded/i.test(state);
}

interface RawFile extends Partial<Transfer> {
  endedAt?: string;
  exception?: string;
}

export interface RawDownloads {
  username?: string;
  directories?: { files?: RawFile[] }[];
}

type TrackedTransfer = Transfer & { endedAt?: string; exception?: string };

export function flattenTransfers(users: RawDownloads[]): TrackedTransfer[] {
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
        placeInQueue: file.placeInQueue || 0,
        endedAt: file.endedAt,
        exception: file.exception,
      })),
    ),
  );
}

const isRemotelyQueued = (t: Transfer) => /queued/i.test(t.state) && /remotely/i.test(t.state);

/** Stopped because slskd closed (not a failure of the transfer itself). */
function isInterrupted(t: TrackedTransfer): boolean {
  return /errored/i.test(t.state) && /application shut ?down/i.test(t.exception || "");
}


export class DownloadTracker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private generation = 0;
  /** When slskd was seen logged in to Soulseek since it started (0: not yet), for the downloads it resumes */
  private loggedInAt = 0;
  private loginCheckedAt = 0;
  private polling: Promise<Transfer[]> | null = null;
  /** The poll that follows the running one, shared by the callers meanwhile */
  private nextPoll: Promise<Transfer[]> | null = null;
  private lastPushed = "";
  /** Transfer id -> when its queue position was last requested */
  private positionAskedAt = new Map<string, number>();
  /** Transfer id -> recent places in the remote queue, and the speed they give */
  private queueStats = new Map<string, { samples: QueueSample[]; estimate?: QueueEstimate }>();
  /** Username -> last known presence and when it was checked */
  private presence = new Map<string, { value: UserPresence; at: number }>();
  /** Single source of truth, written through to downloads.json */
  private pending: Record<string, PendingDownload> = downloadsStore.get("pending");

  constructor(
    private getApi: () => SlskdAPI | null,
    private library: Library,
    /** Folder slskd saves downloads to (the one it was started with) */
    private downloadsDir: () => string,
    private onUpdate: (transfers: Transfer[]) => void,
    private onEvent: (event: DownloadEvent) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loggedInAt = 0;
    this.loginCheckedAt = 0;
    const generation = ++this.generation;
    const loop = async () => {
      await this.refresh().catch((err) => console.error("[Downloads] Poll failed:", err));
      if (generation === this.generation) this.timer = setTimeout(loop, POLL_INTERVAL);
    };
    loop();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.push([]);
  }

  private persist(): void {
    downloadsStore.set("pending", this.pending);
  }

  register(username: string, filename: string, size: number, trackId: string): void {
    this.pending[keyOf(username, filename)] = {
      username,
      filename,
      size,
      trackId,
      requestedAt: Date.now(),
      attempts: 0,
    };
    this.persist();
  }

  forget(username: string, filename: string): void {
    delete this.pending[keyOf(username, filename)];
    this.persist();
  }

  /** Still waiting to be placed (entries that gave up do not count). */
  isPending(username: string, filename: string): boolean {
    const entry = this.pending[keyOf(username, filename)];
    return !!entry && entry.attempts < MAX_ATTEMPTS;
  }

  /** Give a failed placement another round of attempts (on retry). */
  resetAttempts(username: string, filename: string): void {
    const entry = this.pending[keyOf(username, filename)];
    if (!entry) return;
    entry.attempts = 0;
    entry.requestedAt = Date.now();
    delete entry.error;
    this.persist();
  }

  /**
   * Poll slskd, always with a poll started after the call: a running one may
   * predate the caller's change (download asked, removed…), so one more follows
   * it, shared by the callers meanwhile.
   */
  refresh(): Promise<Transfer[]> {
    if (!this.polling) {
      this.polling = this.poll().finally(() => (this.polling = null));
      return this.polling;
    }
    this.nextPoll ??= this.polling
      .catch(() => {})
      .then(() => {
        this.nextPoll = null;
        return this.refresh();
      });
    return this.nextPoll;
  }

  /** Send the list to the UI only when something changed. */
  private push(transfers: Transfer[]): void {
    const serialized = JSON.stringify(transfers);
    if (serialized === this.lastPushed) return;
    this.lastPushed = serialized;
    this.onUpdate(transfers);
  }

  private async poll(): Promise<Transfer[]> {
    const api = this.getApi();
    if (!api) return [];

    const generation = this.generation;
    const raw = flattenTransfers((await api.getDownloads()) as RawDownloads[]);
    // Stopped while the request was in flight: drop the stale list
    if (generation !== this.generation) return [];
    const resuming = await this.isResuming(api, raw);
    if (generation !== this.generation) return [];
    const transfers: Transfer[] = raw.map((r) => {
      const { endedAt: _endedAt, exception: _exception, ...t } = r;
      const queued = isRemotelyQueued(t);
      const askedAt = queued ? this.positionAskedAt.get(t.id) : undefined;
      return {
        ...t,
        ...(isInterrupted(r) && (resuming ? { state: "Resuming" } : { interrupted: true })),
        trackId: this.pending[keyOf(t.username, t.filename)]?.trackId,
        userPresence: queued ? this.presence.get(t.username)?.value : undefined,
        queueEstimate: queued ? this.queueStats.get(t.id)?.estimate : undefined,
        // When the position was last asked, for the UI's countdown to the next check
        queueCheck: askedAt ? { at: askedAt, every: REMOTE_QUEUE_INTERVAL } : undefined,
      };
    });
    this.push(transfers);

    this.refreshRemoteQueues(api, raw);
    await this.processFinished(raw);
    this.pruneStale(raw);
    return transfers;
  }

  /** Whether downloads interrupted by closing slskd may still be requested again by it. */
  private async isResuming(api: SlskdAPI, transfers: TrackedTransfer[]): Promise<boolean> {
    const now = Date.now();
    if (!this.loggedInAt && now - this.loginCheckedAt >= LOGIN_CHECK_INTERVAL && transfers.some(isInterrupted)) {
      this.loginCheckedAt = now;
      const { state = "" } = await api.getServerState().catch(() => ({ state: "" }));
      if (state.includes("LoggedIn")) this.loggedInAt = Date.now();
    }
    return !this.loggedInAt || Date.now() - this.loggedInAt < RESUME_GRACE;
  }

  /**
   * Keep the recent places of a download waiting in a remote queue. Only
   * fresh answers count: the place slskd returns with the transfers can be
   * minutes old (after a restart), which would fake a sudden jump.
   */
  private recordQueuePlace(id: string, place: number): void {
    const stats = this.queueStats.get(id) ?? { samples: [] };
    const samples = addQueueSample(stats.samples, place, Date.now());
    if (samples !== stats.samples) this.queueStats.set(id, { samples, estimate: estimateQueue(samples) });
  }

  /**
   * For downloads waiting in someone's queue, ask in the background (at most
   * once a minute) for our position and whether that user is still online.
   */
  private refreshRemoteQueues(api: SlskdAPI, transfers: Transfer[]): void {
    const now = Date.now();
    const queued = transfers.filter(isRemotelyQueued);

    for (const t of queued) {
      if (now - (this.positionAskedAt.get(t.id) ?? 0) < REMOTE_QUEUE_INTERVAL) continue;
      this.positionAskedAt.set(t.id, now);
      api
        .refreshPlaceInQueue(t.username, t.id)
        .then((place) => {
          // Still waiting (not started or cancelled while asking)
          if (place && this.positionAskedAt.has(t.id)) this.recordQueuePlace(t.id, place);
        })
        .catch(() => {
          // The remote user may be offline; the last known position is kept
        });
    }

    for (const username of new Set(queued.map((t) => t.username))) {
      const known = this.presence.get(username);
      if (known && now - known.at < REMOTE_QUEUE_INTERVAL) continue;
      this.presence.set(username, { value: known?.value ?? "online", at: now });
      api
        .getUserPresence(username)
        .then((value) => this.presence.set(username, { value, at: now }))
        .catch(() => {});
    }

    // Forget transfers and users that left the remote queues
    const ids = new Set(queued.map((t) => t.id));
    for (const id of this.positionAskedAt.keys()) if (!ids.has(id)) this.positionAskedAt.delete(id);
    for (const id of this.queueStats.keys()) if (!ids.has(id)) this.queueStats.delete(id);
    const users = new Set(queued.map((t) => t.username));
    for (const user of this.presence.keys()) if (!users.has(user)) this.presence.delete(user);
  }

  private async processFinished(transfers: TrackedTransfer[]): Promise<void> {
    for (const t of transfers) {
      const key = keyOf(t.username, t.filename);
      const entry = this.pending[key];
      if (!entry || !isSucceeded(t.state) || entry.attempts >= MAX_ATTEMPTS) continue;
      // An older finished transfer of the same file (re-download): wait for the new one
      if (t.endedAt && parseUtc(t.endedAt) < entry.requestedAt) continue;

      try {
        const filePath = await this.locate(t, entry.requestedAt);
        if (!filePath) {
          // slskd may still be moving the file out of the incomplete folder
          throw new Error("Fichier téléchargé introuvable dans la bibliothèque");
        }
        const result = await this.library.placeFile(filePath, entry.trackId);
        delete this.pending[key];
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
      this.persist();
    }
  }

  /** Forget requests whose transfer vanished from slskd long ago. */
  private pruneStale(transfers: Transfer[]): void {
    const known = new Set(transfers.map((t) => keyOf(t.username, t.filename)));
    let changed = false;
    for (const [key, entry] of Object.entries(this.pending)) {
      if (!known.has(key) && Date.now() - entry.requestedAt > STALE_AFTER) {
        delete this.pending[key];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Local path of a finished download: where slskd puts it, or the copy it
   * renamed on a name collision ("name_<ticks>.ext"). Among same-size
   * candidates, the newest one written after the request wins.
   */
  private async locate(t: Transfer, requestedAt: number): Promise<string | null> {
    const root = this.downloadsDir();
    if (!root) return null;
    const expected = slskdLocalPath(root, t.filename);
    if (!isInside(expected, root)) return null;

    const stem = path.basename(expected, path.extname(expected)).toLowerCase();
    const candidates: { path: string; mtime: number }[] = [];
    for (const p of await listAudioFiles(root)) {
      if (!path.basename(p).toLowerCase().startsWith(stem)) continue;
      const stats = await fs.promises.stat(p).catch(() => null);
      if (stats && (!t.size || stats.size === t.size)) candidates.push({ path: p, mtime: stats.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const recent = candidates.find((c) => c.mtime >= requestedAt - 60_000);
    return (recent ?? candidates[0])?.path ?? null;
  }
}
