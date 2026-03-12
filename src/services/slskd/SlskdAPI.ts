// ─── slskd REST API Client ──────────────────────────────────
import axios, { AxiosInstance } from "axios";
import type { SlskdSearchResult } from "../../types";

interface ServerState {
  state: string;
  username?: string;
}

interface SearchResponse {
  id: string;
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
    return response.data;
  }

  async getSearchResults(searchId: string): Promise<SearchResponse> {
    const response = await this.client.get(`/api/v0/searches/${searchId}`);
    return response.data;
  }

  async searchAndWait(
    query: string,
    waitMs = 5000,
  ): Promise<{ id: string; results: SlskdSearchResult[] }> {
    const search = await this.search(query);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const results = await this.getSearchResults(search.id);
    return {
      id: search.id,
      results: this.flattenSearchResults(results),
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
    files: Array<{ filename: string } | string>,
  ): Promise<void> {
    await this.client.post(
      `/api/v0/transfers/downloads/${username}`,
      files.map((f) => ({ filename: typeof f === "string" ? f : f.filename })),
    );
  }

  async getDownloads(): Promise<unknown[]> {
    const response = await this.client.get("/api/v0/transfers/downloads");
    return response.data;
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
