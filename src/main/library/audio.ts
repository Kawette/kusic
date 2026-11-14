// ─── Local audio playback ──────────────────────────────────
// Library files are streamed to the renderer's <audio> element through the
// kusic-audio:// protocol (with Range support for seeking). Only audio files
// inside the library folder are served.

import { protocol } from "electron";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { isInside } from "./naming.js";

const AUDIO_SCHEME = "kusic-audio";

export const audioSchemePrivileges = {
  scheme: AUDIO_SCHEME,
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
};

/** Formats Chromium can play (keep in sync with PLAYABLE in renderer/js/ui.js) */
const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

/** Parse a "bytes=start-end" header against a file size; null if invalid. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

export function handleAudioProtocol(libraryRoot: () => string): void {
  protocol.handle(AUDIO_SCHEME, async (request) => {
    const filePath = new URL(request.url).searchParams.get("path") || "";
    const root = libraryRoot();
    const type = MIME[path.extname(filePath).toLowerCase()];
    if (!root || !type || !isInside(filePath, root)) return new Response(null, { status: 403 });

    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats?.isFile()) return new Response(null, { status: 404 });
    if (stats.size === 0) return new Response(null, { status: 200, headers: { "Content-Type": type } });

    const range = request.headers.has("range")
      ? parseRange(request.headers.get("range"), stats.size)
      : { start: 0, end: stats.size - 1 };
    if (!range) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stats.size}` } });
    }

    const { start, end } = range;
    const body = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream;
    const partial = request.headers.has("range");
    return new Response(body, {
      status: partial ? 206 : 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        ...(partial ? { "Content-Range": `bytes ${start}-${end}/${stats.size}` } : {}),
      },
    });
  });
}
