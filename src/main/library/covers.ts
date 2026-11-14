// ─── Cover thumbnails cache ────────────────────────────────
// Embedded covers are stored as 200px JPEG thumbnails in
// %APPDATA%/kusic/covers, named by content hash, and served to the renderer
// through the kusic-cover:// protocol. The folder can be deleted at any time:
// missing thumbnails are rebuilt from the audio files on the next scan.

import { app, nativeImage, net, protocol } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

export const COVER_SCHEME = "kusic-cover";
const THUMB_WIDTH = 200;
const HASH = /^[a-f0-9]{24}$/;

const coversDir = () => path.join(app.getPath("userData"), "covers");

export const coverSchemePrivileges = {
  scheme: COVER_SCHEME,
  privileges: { standard: true, secure: true },
};

export function handleCoverProtocol(): void {
  protocol.handle(COVER_SCHEME, (request) => {
    const hash = new URL(request.url).hostname;
    if (!HASH.test(hash)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path.join(coversDir(), `${hash}.jpg`)).href);
  });
}

/** False when a kusic-cover:// thumbnail was deleted from the cache folder. */
export function coverExists(url: string): boolean {
  if (!url.startsWith(`${COVER_SCHEME}://`)) return true;
  return fs.existsSync(path.join(coversDir(), `${url.slice(COVER_SCHEME.length + 3)}.jpg`));
}

/** Save a thumbnail of an embedded picture and return its URL ("" on failure). */
export function saveCover(data: Uint8Array): string {
  const hash = crypto.createHash("sha1").update(data).digest("hex").slice(0, 24);
  const file = path.join(coversDir(), `${hash}.jpg`);

  if (!fs.existsSync(file)) {
    let image = nativeImage.createFromBuffer(Buffer.from(data));
    if (image.isEmpty()) return "";
    if (image.getSize().width > THUMB_WIDTH) {
      image = image.resize({ width: THUMB_WIDTH, quality: "good" });
    }
    fs.mkdirSync(coversDir(), { recursive: true });
    fs.writeFileSync(file, image.toJPEG(85));
  }

  return `${COVER_SCHEME}://${hash}`;
}
