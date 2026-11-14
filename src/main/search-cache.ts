// ─── Persistent Soulseek search cache ──────────────────────
// Results are kept for a few days so that auto-search work survives
// restarts. Searches without results are cached too (for a shorter time) so
// they are not repeated on every auto-search run.

import { app } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { searchCacheIndex } from "./store.js";
import type { SlskdSearchResult } from "../types.js";

const TTL = 3 * 24 * 60 * 60 * 1000;
const EMPTY_TTL = 12 * 60 * 60 * 1000;
const MAX_RESULTS = 300;

const cacheDir = () => path.join(app.getPath("userData"), "search-cache");

export function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, " ");
}

function isFresh(entry: { count: number; timestamp: number }): boolean {
  return Date.now() - entry.timestamp < (entry.count > 0 ? TTL : EMPTY_TTL);
}

export function getCachedSearch(
  query: string,
): { results: SlskdSearchResult[]; timestamp: number } | null {
  const entry = searchCacheIndex.get("searches")[normalizeQuery(query)];
  if (!entry || !isFresh(entry)) return null;
  try {
    const results = JSON.parse(fs.readFileSync(path.join(cacheDir(), entry.file), "utf8"));
    return { results, timestamp: entry.timestamp };
  } catch {
    return null;
  }
}

export function setCachedSearch(query: string, results: SlskdSearchResult[]): void {
  const key = normalizeQuery(query);
  const file = `${crypto.createHash("sha1").update(key).digest("hex")}.json`;
  const kept = results.slice(0, MAX_RESULTS);
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(path.join(cacheDir(), file), JSON.stringify(kept), "utf8");
  // Keys contain dots/spaces: update the whole map rather than a dotted path
  const searches = searchCacheIndex.get("searches");
  searches[key] = { file, count: kept.length, timestamp: Date.now() };
  searchCacheIndex.set("searches", searches);
}

/** Fresh cached queries with their result count, for the track list badges. */
export function getCacheSummary(): Record<string, { count: number; timestamp: number }> {
  const summary: Record<string, { count: number; timestamp: number }> = {};
  for (const [key, entry] of Object.entries(searchCacheIndex.get("searches"))) {
    if (isFresh(entry)) summary[key] = { count: entry.count, timestamp: entry.timestamp };
  }
  return summary;
}

/** Drop expired entries and their files. */
export function pruneSearchCache(): void {
  const searches = searchCacheIndex.get("searches");
  for (const [key, entry] of Object.entries(searches)) {
    if (isFresh(entry)) continue;
    fs.rmSync(path.join(cacheDir(), entry.file), { force: true });
    delete searches[key];
  }
  searchCacheIndex.set("searches", searches);
}
