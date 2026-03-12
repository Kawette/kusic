// ─── slskd REST API Client ──────────────────────────────────────
// Handles all communication with the slskd REST API

const axios = require('axios');

class SlskdAPI {
  constructor(baseUrl = 'http://localhost:5030', auth = null) {
    this.baseUrl = baseUrl;
    this.auth = auth;
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add auth if provided
    if (auth && auth.username && auth.password) {
      this.client.defaults.auth = {
        username: auth.username,
        password: auth.password
      };
    }
  }

  /**
   * Update authentication credentials
   */
  setAuth(username, password) {
    this.auth = { username, password };
    this.client.defaults.auth = { username, password };
  }

  // ─── Server Status ─────────────────────────────────────────────

  /**
   * Check if slskd API is available
   */
  async healthCheck() {
    try {
      const response = await this.client.get('/api/v0/application');
      return response.status === 200;
    } catch (err) {
      // If we get any response, server is running
      if (err.response) {
        return err.response.status === 200;
      }
      return false;
    }
  }

  /**
   * Get server state (connection status)
   */
  async getServerState() {
    const response = await this.client.get('/api/v0/server');
    return response.data;
  }

  /**
   * Connect to Soulseek network
   */
  async connect() {
    const response = await this.client.put('/api/v0/server');
    return response.data;
  }

  /**
   * Disconnect from Soulseek network
   */
  async disconnect() {
    const response = await this.client.delete('/api/v0/server');
    return response.data;
  }

  // ─── Search ────────────────────────────────────────────────────

  /**
   * Start a new search
   * @param {string} query Search query
   * @returns {Object} Search info with id
   */
  async search(query) {
    const response = await this.client.post('/api/v0/searches', {
      searchText: query
    });
    return response.data;
  }

  /**
   * Get search results
   * @param {string} searchId Search ID
   * @returns {Object} Search results
   */
  async getSearchResults(searchId) {
    const response = await this.client.get(`/api/v0/searches/${searchId}`);
    return response.data;
  }

  /**
   * Get all active searches
   */
  async getSearches() {
    const response = await this.client.get('/api/v0/searches');
    return response.data;
  }

  /**
   * Delete/stop a search
   */
  async deleteSearch(searchId) {
    const response = await this.client.delete(`/api/v0/searches/${searchId}`);
    return response.data;
  }

  /**
   * Search and wait for results (convenience method)
   * @param {string} query Search query
   * @param {number} waitMs Time to wait for results in ms
   * @returns {Array} Search results
   */
  async searchAndWait(query, waitMs = 5000) {
    const search = await this.search(query);
    
    // Wait for results to come in
    await new Promise(resolve => setTimeout(resolve, waitMs));
    
    const results = await this.getSearchResults(search.id);
    return {
      id: search.id,
      results: this._flattenSearchResults(results)
    };
  }

  /**
   * Flatten search results into a simple array
   */
  _flattenSearchResults(searchData) {
    const results = [];
    
    if (!searchData.responses) return results;
    
    for (const response of searchData.responses) {
      const username = response.username;
      const freeUploadSlots = response.freeUploadSlots;
      const uploadSpeed = response.uploadSpeed;
      
      for (const file of (response.files || [])) {
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
          extension: this._getExtension(file.filename),
          quality: this._getQualityScore(file)
        });
      }
    }
    
    // Sort by quality score (higher is better)
    return results.sort((a, b) => b.quality - a.quality);
  }

  _getExtension(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  _getQualityScore(file) {
    let score = 0;
    const ext = this._getExtension(file.filename);
    
    // Format score
    if (ext === 'flac') score += 100;
    else if (ext === 'wav') score += 90;
    else if (ext === 'mp3') score += 50;
    else if (ext === 'm4a' || ext === 'aac') score += 45;
    else if (ext === 'ogg') score += 40;
    
    // Bitrate score (for lossy)
    if (file.bitRate) {
      if (file.bitRate >= 320) score += 30;
      else if (file.bitRate >= 256) score += 20;
      else if (file.bitRate >= 192) score += 10;
    }
    
    // Bit depth score (for lossless)
    if (file.bitDepth) {
      if (file.bitDepth >= 24) score += 20;
      else if (file.bitDepth >= 16) score += 10;
    }
    
    return score;
  }

  // ─── Downloads ─────────────────────────────────────────────────

  /**
   * Download files from a user
   * @param {string} username Soulseek username
   * @param {Array} files Array of file objects with filename property
   */
  async download(username, files) {
    const response = await this.client.post(`/api/v0/transfers/downloads/${username}`, 
      files.map(f => ({ filename: f.filename || f }))
    );
    return response.data;
  }

  /**
   * Get all downloads
   */
  async getDownloads() {
    const response = await this.client.get('/api/v0/transfers/downloads');
    return response.data;
  }

  /**
   * Get downloads from specific user
   */
  async getUserDownloads(username) {
    const response = await this.client.get(`/api/v0/transfers/downloads/${username}`);
    return response.data;
  }

  /**
   * Cancel a download
   */
  async cancelDownload(username, filename, remove = false) {
    const id = encodeURIComponent(filename);
    const response = await this.client.delete(
      `/api/v0/transfers/downloads/${username}/${id}?remove=${remove}`
    );
    return response.data;
  }

  // ─── Uploads ───────────────────────────────────────────────────

  /**
   * Get all uploads (what you're sharing)
   */
  async getUploads() {
    const response = await this.client.get('/api/v0/transfers/uploads');
    return response.data;
  }

  // ─── Shares ────────────────────────────────────────────────────

  /**
   * Get shared directories info
   */
  async getShares() {
    const response = await this.client.get('/api/v0/shares');
    return response.data;
  }

  /**
   * Rescan shared directories
   */
  async rescanShares() {
    const response = await this.client.put('/api/v0/shares');
    return response.data;
  }

  // ─── Options ───────────────────────────────────────────────────

  /**
   * Get application options
   */
  async getOptions() {
    const response = await this.client.get('/api/v0/options');
    return response.data;
  }
}

module.exports = SlskdAPI;
