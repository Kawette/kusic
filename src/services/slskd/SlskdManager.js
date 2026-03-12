// ─── slskd Process Manager ──────────────────────────────────────
// Manages the lifecycle of the slskd process
// ⚠️ Windows only - version locked to avoid breaking changes

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { app } = require('electron');
const SlskdConfig = require('./SlskdConfig');
const SlskdAPI = require('./SlskdAPI');

// Version locked to ensure API compatibility
const SLSKD_VERSION = '0.24.5';
const SUPPORTED_PLATFORM = 'win32';

class SlskdManager {
  constructor() {
    this.process = null;
    this.api = null;
    this.config = null;
    this.webAuth = null;
    this.isRunning = false;
    this.version = SLSKD_VERSION;
    
    // Paths
    this.resourcesPath = path.join(app.getPath('userData'), 'slskd');
    this.binaryPath = this._getBinaryPath();
    this.configPath = path.join(this.resourcesPath, 'slskd.yml');
    this.dataPath = path.join(this.resourcesPath, 'data');
    
    this.configManager = new SlskdConfig(this.configPath);
  }

  /**
   * Check if current platform is supported
   */
  isPlatformSupported() {
    return process.platform === SUPPORTED_PLATFORM;
  }

  _getBinaryPath() {
    // Windows only
    if (process.platform !== 'win32') {
      console.warn('[slskd] Cette plateforme n\'est pas supportée. Seul Windows est supporté.');
      return null;
    }
    
    const arch = process.arch;
    const platformFolder = arch === 'arm64' ? 'win-arm64' : 'win-x64';
    
    return path.join(this.resourcesPath, 'bin', platformFolder, 'slskd.exe');
  }

  /**
   * Get slskd download URL (Windows only)
   */
  _getDownloadUrl() {
    if (process.platform !== 'win32') {
      throw new Error('Seul Windows est supporté actuellement');
    }
    
    const arch = process.arch;
    const platformSuffix = arch === 'arm64' ? 'win-arm64' : 'win-x64';
    
    return `https://github.com/slskd/slskd/releases/download/${SLSKD_VERSION}/slskd-${SLSKD_VERSION}-${platformSuffix}.zip`;
  }

  /**
   * Get the installed version
   */
  getVersion() {
    return this.version;
  }

  /**
   * Check if slskd binary exists
   */
  isBinaryInstalled() {
    if (!this.binaryPath) return false;
    return fs.existsSync(this.binaryPath);
  }

  /**
   * Download and extract slskd binary (Windows only)
   * @param {Function} onProgress Progress callback (percentage)
   */
  async downloadBinary(onProgress = () => {}) {
    if (!this.isPlatformSupported()) {
      throw new Error('Seul Windows est supporté actuellement. macOS et Linux ne sont pas disponibles.');
    }
    
    const url = this._getDownloadUrl();
    const zipPath = path.join(this.resourcesPath, 'slskd.zip');
    const binDir = path.dirname(this.binaryPath);
    
    // Ensure directories exist
    fs.mkdirSync(binDir, { recursive: true });
    
    // Download zip file
    await this._downloadFile(url, zipPath, onProgress);
    
    // Extract zip
    const extract = require('extract-zip');
    await extract(zipPath, { dir: binDir });
    
    // Clean up zip
    fs.unlinkSync(zipPath);
    
    // Save version info
    const versionFile = path.join(this.resourcesPath, 'version.json');
    fs.writeFileSync(versionFile, JSON.stringify({ 
      version: SLSKD_VERSION, 
      installedAt: new Date().toISOString(),
      platform: 'win32',
      arch: process.arch
    }), 'utf8');
    
    return this.binaryPath;
  }

  _downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      
      const request = (url.startsWith('https') ? https : http).get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          fs.unlinkSync(destPath);
          return this._downloadFile(response.headers.location, destPath, onProgress)
            .then(resolve)
            .catch(reject);
        }
        
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;
        
        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize) {
            onProgress(Math.round((downloadedSize / totalSize) * 100));
          }
        });
        
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve(destPath);
        });
      });
      
      request.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
  }

  /**
   * Start slskd with the given configuration
   * @param {Object} options
   * @param {string} options.username Soulseek username
   * @param {string} options.password Soulseek password
   * @param {string} options.libraryPath Library/share path
   */
  async start(options) {
    if (this.isRunning) {
      console.log('[slskd] Already running');
      return this.api;
    }

    // Validate options
    if (!options.username || !options.password) {
      throw new Error('Soulseek username and password are required');
    }
    if (!options.libraryPath) {
      throw new Error('Library path is required');
    }

    // Check if binary exists
    if (!this.isBinaryInstalled()) {
      throw new Error('slskd binary not found. Please download it first.');
    }

    // Generate config
    const { webAuth } = this.configManager.generate({
      username: options.username,
      password: options.password,
      libraryPath: options.libraryPath,
      webPort: 5030,
      listenPort: 50300
    });
    this.webAuth = webAuth;

    // Ensure data directory exists
    fs.mkdirSync(this.dataPath, { recursive: true });

    // Start process
    return new Promise((resolve, reject) => {
      const args = [
        '--config', this.configPath,
        '--app-dir', this.dataPath,
        '--no-logo'
      ];

      console.log(`[slskd] Starting: ${this.binaryPath} ${args.join(' ')}`);
      
      this.process = spawn(this.binaryPath, args, {
        cwd: this.resourcesPath,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let startupOutput = '';

      this.process.stdout.on('data', (data) => {
        const output = data.toString();
        startupOutput += output;
        console.log('[slskd]', output.trim());
      });

      this.process.stderr.on('data', (data) => {
        console.error('[slskd:err]', data.toString().trim());
      });

      this.process.on('error', (err) => {
        console.error('[slskd] Process error:', err);
        this.isRunning = false;
        reject(err);
      });

      this.process.on('close', (code) => {
        console.log(`[slskd] Process exited with code ${code}`);
        this.isRunning = false;
        this.process = null;
      });

      // Wait for API to be ready
      this._waitForReady()
        .then(() => {
          this.isRunning = true;
          this.api = new SlskdAPI('http://localhost:5030');
          resolve(this.api);
        })
        .catch((err) => {
          this.stop();
          reject(new Error(`slskd failed to start: ${err.message}`));
        });
    });
  }

  async _waitForReady(maxAttempts = 30, interval = 1000) {
    const tempApi = new SlskdAPI('http://localhost:5030');
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const isReady = await tempApi.healthCheck();
        if (isReady) {
          console.log('[slskd] API is ready');
          return true;
        }
      } catch {
        // Ignore errors during startup
      }
      await new Promise(r => setTimeout(r, interval));
    }
    
    throw new Error('Timeout waiting for slskd to start');
  }

  /**
   * Stop slskd process
   */
  stop() {
    if (this.process) {
      console.log('[slskd] Stopping process...');
      
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', this.process.pid, '/f', '/t']);
      } else {
        this.process.kill('SIGTERM');
      }
      
      this.process = null;
      this.isRunning = false;
      this.api = null;
    }
  }

  /**
   * Restart slskd with new options
   */
  async restart(options) {
    this.stop();
    await new Promise(r => setTimeout(r, 2000)); // Wait for cleanup
    return this.start(options);
  }

  /**
   * Get the API instance
   */
  getAPI() {
    if (!this.api) {
      throw new Error('slskd is not running');
    }
    return this.api;
  }

  /**
   * Check if slskd is running and connected
   */
  async getStatus() {
    if (!this.isRunning || !this.api) {
      return { running: false, connected: false };
    }
    
    try {
      const state = await this.api.getServerState();
      // state.state can be: "Disconnected", "Connecting", "Connected", "LoggedIn", "Connected, LoggedIn"
      const stateStr = state.state || '';
      const isConnected = stateStr.includes('Connected');
      const isLoggedIn = stateStr.includes('LoggedIn');
      
      return {
        running: true,
        connected: isConnected && isLoggedIn,
        connecting: isConnected && !isLoggedIn,
        username: state.username,
        state: stateStr
      };
    } catch (err) {
      // Process is running but API might not be ready yet
      return { running: true, connected: false, state: 'Démarrage...' };
    }
  }
}

module.exports = SlskdManager;
