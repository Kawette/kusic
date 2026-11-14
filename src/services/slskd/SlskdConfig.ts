// ─── slskd Configuration Generator ─────────────────────────
import fs from "fs";
import path from "path";
import yaml from "yaml";

export interface SlskdConfigOptions {
  username: string;
  libraryPath: string;
  incompletePath: string;
  webPort: number;
  listenPort: number;
}

// Secrets (Soulseek password, API key) are passed through environment
// variables by SlskdManager and never written to this file.
export class SlskdConfig {
  constructor(private configPath: string) {}

  generate(options: SlskdConfigOptions): void {
    const { username, libraryPath, incompletePath, webPort, listenPort } = options;

    fs.mkdirSync(libraryPath, { recursive: true });
    fs.mkdirSync(incompletePath, { recursive: true });

    // Older versions kept partial downloads inside the library: never share them
    const legacyIncomplete = path.join(libraryPath, ".incomplete");
    const shareDirs = [libraryPath];
    if (fs.existsSync(legacyIncomplete)) shareDirs.push(`!${legacyIncomplete}`);

    const config = {
      soulseek: {
        username,
        description: "Kusic User",
        listen_port: listenPort,
      },
      directories: {
        downloads: libraryPath,
        incomplete: incompletePath,
      },
      shares: {
        directories: shareDirs,
        filters: ["\\.ini$", "\\.db$", "Thumbs\\.db$", "\\.DS_Store$", "\\.part$"],
      },
      web: {
        port: webPort,
        ip_address: "127.0.0.1",
        https: { disabled: true }, // Would listen on every interface
        url_base: "/",
        authentication: { disabled: false },
      },
      transfers: {
        upload: { slots: 5 },
        download: {
          slots: 10,
          // Failed downloads are retried and partial files resumed by slskd
          retry: { partial: "resume", attempts: 3, delay: 5000, max_delay: 60000 },
        },
      },
      retention: {
        transfers: {
          upload: { succeeded: 1440, errored: 1440 },
          download: { succeeded: 1440, errored: 1440 },
        },
      },
    };

    fs.writeFileSync(this.configPath, yaml.stringify(config), "utf8");
  }
}
