// ─── slskd REST API Client ──────────────────────────────────
import axios, { AxiosInstance } from "axios";
import type { SlskdSearchResult } from "../../types.js";

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
    freeUploadSlots: number;
    uploadSpeed: number;
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

  constructor(baseUrl = "http://localhost:5030") {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get("/api/v0/application");
      return response.status === 200;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        return err.response.status === 200;
      }
      return false;
    }
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

  async cancelSearch(searchId: string): Promise<void> {
    try {
      await this.client.delete(`/api/v0/searches/${searchId}`);
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
    const url = includeFiles
      ? `/api/v0/searches/${searchId}?includeResponses=true`
      : `/api/v0/searches/${searchId}`;
    const response = await this.client.get(url);
    return {
      results: includeFiles ? this.flattenSearchResults(response.data) : [],
      isComplete: response.data.isComplete,
      fileCount: response.data.fileCount,
    };
  }

  flattenSearchResults(searchData: SearchResponse): SlskdSearchResult[] {
    const results: SlskdSearchResult[] = [];

    if (!searchData.responses) return results;

    for (const response of searchData.responses) {
      const { username, freeUploadSlots, uploadSpeed } = response;

      for (const file of response.files || []) {
        results.push({
          username,
          freeUploadSlots,
          uploadSpeed,
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
    files: Array<{ filename: string; size: number } | string>,
  ): Promise<void> {
    await this.client.post(
      `/api/v0/transfers/downloads/${username}`,
      files.map((f) =>
        typeof f === "string"
          ? { filename: f }
          : { filename: f.filename, size: f.size },
      ),
    );
  }

  async getDownloads(): Promise<unknown[]> {
    const response = await this.client.get("/api/v0/transfers/downloads");
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
    // Remove the old failed transfer first
    await this.client.delete(
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}?remove=true`,
    );
    // Re-enqueue
    const file: { filename: string; size?: number } = { filename };
    if (size > 0) file.size = size;
    await this.client.post(
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}`,
      [file],
    );
  }

  async clearCompletedDownloads(): Promise<void> {
    await this.client.delete("/api/v0/transfers/downloads/all/completed");
  }

  async getUploads(): Promise<unknown[]> {
    const response = await this.client.get("/api/v0/transfers/uploads");
    return response.data;
  }

  async getShares(): Promise<unknown> {
    const response = await this.client.get("/api/v0/shares");
    return response.data;
  }

  async rescanShares(): Promise<void> {
    await this.client.put("/api/v0/shares");
  }
}
