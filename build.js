import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Compile TypeScript (main)
console.log("Compiling TypeScript (main)...");
execSync("npx tsc", { stdio: "inherit" });

// 2. Compile preload (CommonJS)
console.log("Compiling preload (CommonJS)...");
execSync("npx tsc -p tsconfig.preload.json", { stdio: "inherit" });

// 3. Copy renderer files
console.log("Copying renderer files...");

const srcDir = path.join(__dirname, "src", "renderer");
const destDir = path.join(__dirname, "dist", "renderer");

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

const files = ["index.html", "styles.css", "renderer.js"];

for (const file of files) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${file}`);
  } else {
    console.warn(`  ✗ ${file} not found`);
  }
}

console.log("Build complete!");
