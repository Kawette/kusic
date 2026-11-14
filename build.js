import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist");

// 1. Start clean so removed modules are never shipped
fs.rmSync(distDir, { recursive: true, force: true });

// 2. Compile TypeScript (main as ESM, preload.cts as CommonJS)
console.log("Compiling TypeScript...");
execSync("npx tsc", { stdio: "inherit" });

// 3. Copy renderer files
console.log("Copying renderer files...");
fs.cpSync(path.join(__dirname, "src", "renderer"), path.join(distDir, "renderer"), {
  recursive: true,
});

console.log("Build complete!");
