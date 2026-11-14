// ─── slskd REST API Client ──────────────────────────────────
import axios, { AxiosInstance } from "axios";
import type { SlskdSearchResult, UserPresence } from "../../types.js";

interface ServerState {
  state: string;
  username?: string;
}

interface SearchResponse {
  id: string;
  state: string;
  isComplete: boolean;
  fileCount: number;
  responseCount: number;
  responses?: Array<{
    username: string;
    hasFreeUploadSlot: boolean;
    uploadSpeed: number;
    queueLength?: number;
    files?: Array<{
      filename: string;
      size: number;
      bitRate?: number;
      sampleRate?: number;
      bitDepth?: number;
      length?: number;
    }>;
  }>;
}

export class SlskdAPI {
  private client: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get("/api/v0/application");
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /** Re-index the shared folders (409 = a scan is already running). */
  async rescanShares(): Promise<void> {
    await this.client.put("/api/v0/shares", undefined, {
      validateStatus: (s) => s < 300 || s === 409,
    });
  }

  async getServerState(): Promise<ServerState> {
    const response = await this.client.get("/api/v0/server");
    return response.data;
  }

  async search(query: string): Promise<{ id: string }> {
    const response = await this.client.post("/api/v0/searches", {
      searchText: query,
    });
    return { id: response.data.id };
  }

  /** Stop a running search (DELETE would remove it while slskd finalizes it). */
  async cancelSearch(searchId: string): Promise<void> {
    try {
      await this.client.put(`/api/v0/searches/${encodeURIComponent(searchId)}`);
    } catch {
      // Ignore errors - search might already be done
    }
  }

  async getSearchResults(
    searchId: string,
    includeFiles = true,
  ): Promise<{
    results: SlskdSearchResult[];
    isComplete: boolean;
    fileCount: number;
  }> {
    const response = await this.client.get(
      `/api/v0/searches/${encodeURIComponent(searchId)}`,
      { params: includeFiles ? { includeResponses: true } : {} },
    );
    return {
      results: includeFiles ? this.flattenSearchResults(response.data) : [],
      isComplete: response.data.isComplete,
      fileCount: response.data.fileCount,
    };
  }

  private flattenSearchResults(searchData: SearchResponse): SlskdSearchResult[] {
    const results: SlskdSearchResult[] = [];

    if (!searchData.responses) return results;

    for (const response of searchData.responses) {
      const { username, hasFreeUploadSlot, uploadSpeed, queueLength } = response;

      for (const file of response.files || []) {
        results.push({
          username,
          hasFreeUploadSlot,
          uploadSpeed,
          queueLength,
          filename: file.filename,
          size: file.size,
          bitRate: file.bitRate,
          sampleRate: file.sampleRate,
          bitDepth: file.bitDepth,
          length: file.length,
          extension: this.getExtension(file.filename),
          quality: this.getQualityScore(file),
        });
      }
    }

    return results.sort((a, b) => b.quality - a.quality);
  }

  private getExtension(filename: string): string {
    const parts = filename.split(".");
    return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
  }

  private getQualityScore(file: {
    bitRate?: number;
    bitDepth?: number;
    filename: string;
  }): number {
    let score = 0;
    const ext = this.getExtension(file.filename);

    if (ext === "flac") score += 100;
    else if (ext === "wav") score += 90;
    else if (ext === "mp3") score += 50;
    else if (ext === "m4a" || ext === "aac") score += 45;
    else if (ext === "ogg") score += 40;

    if (file.bitRate) {
      if (file.bitRate >= 320) score += 30;
      else if (file.bitRate >= 256) score += 20;
      else if (file.bitRate >= 192) score += 10;
    }

    if (file.bitDepth) {
      if (file.bitDepth >= 24) score += 20;
      else if (file.bitDepth >= 16) score += 10;
    }

    return score;
  }

  async download(
    username: string,
    files: Array<{ filename: string; size?: number }>,
  ): Promise<void> {
    await this.client.post(
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}`,
      files,
    );
  }

  /**
   * Ask the remote user for our position in their upload queue. slskd stores
   * the answer in the transfer (placeInQueue), returned by later polls.
   */
  async refreshPlaceInQueue(username: string, id: string): Promise<void> {
    await this.client.get(
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}/position`,
    );
  }

  /** Whether a Soulseek user is online, away or offline. */
  async getUserPresence(username: string): Promise<UserPresence> {
    const { data } = await this.client.get(`/api/v0/users/${encodeURIComponent(username)}/status`);
    const presence = String(data?.presence ?? "").toLowerCase();
    return presence === "online" || presence === "away" ? presence : "offline";
  }

  async getDownloads(): Promise<unknown[]> {
    const response = await this.client.get("/api/v0/transfers/downloads");
    return response.data;
  }

  async getUploads(): Promise<unknown[]> {
    const response = await this.client.get("/api/v0/transfers/uploads");
    return response.data;
  }

  async cancelDownload(
    username: string,
    id: string,
    remove = false,
  ): Promise<void> {
    await this.client.delete(
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}?remove=${remove}`,
    );
  }

  async retryDownload(
    username: string,
    id: string,
    filename: string,
    size: number,
  ): Promise<void> {
    // Remove the old failed transfer first, then re-enqueue
    await this.cancelDownload(username, id, true);
    await this.download(username, [size > 0 ? { filename, size } : { filename }]);
  }
}
