// ─── slskd Configuration Generator ─────────────────────────
import fs from "fs";
import path from "path";
import yaml from "yaml";

interface SlskdConfigOptions {
  username: string;
  password: string;
  libraryPath: string;
  webPort?: number;
  listenPort?: number;
}

interface SlskdYamlConfig {
  soulseek: {
    username: string;
    password: string;
    description: string;
    listen_port: number;
  };
  directories: {
    downloads: string;
    incomplete: string;
  };
  shares: {
    directories: string[];
    filters: { search: string[] };
  };
  web: {
    port: number;
    url_base: string;
    authentication: { disabled: boolean };
  };
  global: {
    upload: { slots: number };
    download: { slots: number };
  };
  retention: {
    transfers: {
      upload: { succeeded: number; errored: number };
      download: { succeeded: number; errored: number };
    };
  };
}

export class SlskdConfig {
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  generate(options: SlskdConfigOptions): { configPath: string } {
    const {
      username,
      password,
      libraryPath,
      webPort = 5030,
      listenPort = 50300,
    } = options;

    if (!fs.existsSync(libraryPath)) {
      fs.mkdirSync(libraryPath, { recursive: true });
    }

    const incompleteDir = path.join(libraryPath, ".incomplete");
    if (!fs.existsSync(incompleteDir)) {
      fs.mkdirSync(incompleteDir, { recursive: true });
    }

    const config: SlskdYamlConfig = {
      soulseek: {
        username,
        password,
        description: "Kusic User",
        listen_port: listenPort,
      },
      directories: {
        downloads: libraryPath,
        incomplete: incompleteDir,
      },
      shares: {
        directories: [libraryPath],
        filters: {
          search: [
            "\\.ini$",
            "\\.db$",
            "\\.DS_Store$",
            "Thumbs\\.db$",
            "\\.incomplete$",
          ],
        },
      },
      web: {
        port: webPort,
        url_base: "/",
        authentication: { disabled: true },
      },
      global: {
        upload: { slots: 5 },
        download: { slots: 10 },
      },
      retention: {
        transfers: {
          upload: { succeeded: 1440, errored: 1440 },
          download: { succeeded: 1440, errored: 1440 },
        },
      },
    };

    const yamlContent = yaml.stringify(config);
    fs.writeFileSync(this.configPath, yamlContent, "utf8");

    return { configPath: this.configPath };
  }
}
