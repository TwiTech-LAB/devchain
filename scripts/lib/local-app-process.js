const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = join(__dirname, "..", "..");

// Resolve @devchain/shared across packed (dist/node_modules) and workspace (packages/shared
// or apps/local-app/node_modules) layouts. Node's ESM resolver only walks node_modules from
// this script's location, where the workspace symlink does not exist, so dynamic imports must
// use a concrete file:// URL.
let sharedModuleUrlCache;
function resolveSharedModuleSpecifier() {
  if (sharedModuleUrlCache) return sharedModuleUrlCache;
  const candidates = [
    join(ROOT, "dist", "node_modules", "@devchain", "shared", "index.js"),
    join(ROOT, "packages", "shared", "dist", "index.js"),
    join(ROOT, "node_modules", "@devchain", "shared", "dist", "index.js"),
    join(
      ROOT,
      "apps",
      "local-app",
      "node_modules",
      "@devchain",
      "shared",
      "dist",
      "index.js",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      sharedModuleUrlCache = pathToFileURL(candidate).href;
      return sharedModuleUrlCache;
    }
  }
  return "@devchain/shared";
}

function getPidFilePath() {
  const devchainDir = join(homedir(), ".devchain");
  if (!existsSync(devchainDir)) {
    mkdirSync(devchainDir, { recursive: true });
  }
  return join(devchainDir, "devchain.pid");
}

function readPidFile() {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) {
    return null;
  }
  try {
    const data = readFileSync(pidFile, "utf8");
    const parsed = JSON.parse(data);
    if (parsed && !parsed.host) parsed.host = "127.0.0.1";
    return parsed;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getPidFilePath,
  isProcessRunning,
  readPidFile,
  resolveSharedModuleSpecifier,
};
