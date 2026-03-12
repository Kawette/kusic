// ─── slskd Configuration Generator ─────────────────────────────
// Generates the YAML configuration file for slskd

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

class SlskdConfig {
  constructor(configPath) {
    this.configPath = configPath;
  }

  /**
   * Generate slskd configuration file
   * @param {Object} options Configuration options
   * @param {string} options.username Soulseek username
   * @param {string} options.password Soulseek password
   * @param {string} options.libraryPath Path for downloads and sharing
   * @param {number} options.webPort Web API port (default: 5030)
   * @param {number} options.listenPort Soulseek listen port (default: 50300)
   */
  generate(options) {
    const {
      username,
      password,
      libraryPath,
      webPort = 5030,
      listenPort = 50300
    } = options;

    // Ensure library directory exists
    if (!fs.existsSync(libraryPath)) {
      fs.mkdirSync(libraryPath, { recursive: true });
    }

    const incompleteDir = path.join(libraryPath, '.incomplete');
    if (!fs.existsSync(incompleteDir)) {
      fs.mkdirSync(incompleteDir, { recursive: true });
    }

    const config = {
      soulseek: {
        username: username,
        password: password,
        description: 'Kusic User',
        listen_port: listenPort
      },
      directories: {
        downloads: libraryPath,
        incomplete: incompleteDir
      },
      shares: {
        directories: [libraryPath],
        filters: {
          search: [
            '\\.ini$',
            '\\.db$',
            '\\.DS_Store$',
            'Thumbs\\.db$',
            '\\.incomplete$'
          ]
        }
      },
      web: {
        port: webPort,
        url_base: '/',
        authentication: {
          disabled: true
        }
      },
      global: {
        upload: {
          slots: 5
        },
        download: {
          slots: 10
        }
      },
      retention: {
        transfers: {
          upload: {
            succeeded: 1440, // 24 hours
            errored: 1440
          },
          download: {
            succeeded: 1440,
            errored: 1440
          }
        }
      }
    };

    // Write YAML config
    const yamlContent = yaml.stringify(config);
    fs.writeFileSync(this.configPath, yamlContent, 'utf8');

    return {
      configPath: this.configPath,
      webAuth: config.web.authentication
    };
  }

  /**
   * Read existing config
   */
  read() {
    if (!fs.existsSync(this.configPath)) {
      return null;
    }
    const content = fs.readFileSync(this.configPath, 'utf8');
    return yaml.parse(content);
  }

  /**
   * Check if config exists
   */
  exists() {
    return fs.existsSync(this.configPath);
  }
}

module.exports = SlskdConfig;
