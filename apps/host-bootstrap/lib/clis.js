"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI_NAMES = ["claude", "codex", "copilot", "opencode"];
const PACKAGES = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  copilot: "@github/copilot",
  opencode: "opencode-ai",
};
const AGY_INSTALLER = "https://antigravity.google/cli/install.sh";
const CLI_INSTALL_TIMEOUT_MS = 30 * 60_000;
// The provider packages are public; a manifest registry may mirror only
// devchain-cli. Explicit flags win over inherited npm_config_* values that
// could redirect a scope to a private registry.
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const SCOPED_PUBLIC_REGISTRY_FLAGS = Object.values(PACKAGES)
  .filter((name) => name.startsWith("@"))
  .map((name) => `--${name.split("/")[0]}:registry=${PUBLIC_NPM_REGISTRY}`);

function readPins(version, sys) {
  const file = path.join(
    sys.paths.installRoot,
    "versions",
    version,
    "lib/node_modules/devchain-cli/dist/host-cli-pins.json",
  );
  let pins;
  try {
    pins = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `DevChain ${version} is missing dist/host-cli-pins.json.`,
      );
    }
    throw new Error(
      `Cannot read CLI pins for DevChain ${version}: ${error.message}`,
    );
  }
  for (const name of CLI_NAMES) {
    const pin = pins?.[name];
    if (
      pin?.package !== PACKAGES[name] ||
      !/^\d+\.\d+\.\d+$/.test(pin.version)
    ) {
      throw new Error(`DevChain ${version} has an invalid ${name} CLI pin.`);
    }
  }
  if (pins?.agy?.installer !== AGY_INSTALLER) {
    throw new Error(`DevChain ${version} has an invalid agy CLI installer.`);
  }
  return pins;
}

function packageVersion(name, sys) {
  const file = path.join(
    sys.paths.cliPrefix,
    "lib/node_modules",
    PACKAGES[name],
    "package.json",
  );
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).version;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function agyVersion(sys, binary = path.join(sys.paths.binDir, "agy")) {
  if (!fs.existsSync(binary)) return null;
  const { stdout, stderr } = await sys.run(binary, ["--version"]);
  const version = `${stdout}\n${stderr}`.trim().split("\n")[0]?.trim();
  if (!version) throw new Error("agy --version returned no version.");
  return version;
}

function installedAgyVersion(sys) {
  return agyVersion(sys).catch(() => null);
}

async function installAgy(sys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devchain-agy-"));
  const installer = path.join(dir, "install.sh");
  const stagedDir = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const replacement = path.join(sys.paths.binDir, ".agy.new");
  try {
    fs.mkdirSync(stagedDir);
    fs.mkdirSync(home);
    await sys.run("curl", ["-fsSL", AGY_INSTALLER, "-o", installer], {
      timeoutMs: CLI_INSTALL_TIMEOUT_MS,
    });
    await sys.run("bash", [installer, "--dir", stagedDir], {
      timeoutMs: CLI_INSTALL_TIMEOUT_MS,
      env: { ...process.env, HOME: home },
    });
    const staged = path.join(stagedDir, "agy");
    const version = await agyVersion(sys, staged);
    if (!version) throw new Error("installer did not provide an agy binary.");
    // A broken installed agy counts as absent, so a working download replaces it.
    if (version !== (await installedAgyVersion(sys))) {
      fs.rmSync(replacement, { force: true });
      fs.copyFileSync(staged, replacement);
      fs.chmodSync(replacement, 0o755);
      fs.renameSync(replacement, path.join(sys.paths.binDir, "agy"));
    }
    return version;
  } finally {
    fs.rmSync(replacement, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function installClis(version, sys) {
  const pins = readPins(version, sys);
  const installed = {};
  for (const name of CLI_NAMES) {
    try {
      const pin = pins[name];
      if (packageVersion(name, sys) !== pin.version) {
        await sys.run(
          "npm",
          [
            "install",
            "-g",
            "--omit=dev",
            "--no-fund",
            "--no-audit",
            `--prefix=${sys.paths.cliPrefix}`,
            `--registry=${PUBLIC_NPM_REGISTRY}`,
            ...SCOPED_PUBLIC_REGISTRY_FLAGS,
            `${pin.package}@${pin.version}`,
          ],
          { timeoutMs: CLI_INSTALL_TIMEOUT_MS },
        );
      }
      if (
        packageVersion(name, sys) !== pin.version ||
        !fs.existsSync(path.join(sys.paths.binDir, name))
      ) {
        throw new Error(
          `version ${pin.version} or its binary was not installed.`,
        );
      }
      installed[name] = pin.version;
    } catch (error) {
      throw new Error(`CLI ${name} failed: ${error.message}`);
    }
  }
  try {
    installed.agy = await installAgy(sys);
  } catch (error) {
    // An outage of the download site must not block DevChain updates while a
    // working agy is installed; the kept version is recorded so the record
    // stays truthful about what actually runs.
    const kept = await installedAgyVersion(sys);
    if (kept === null) throw new Error(`CLI agy failed: ${error.message}`);
    installed.agy = kept;
    process.stderr.write(
      `agy update skipped: ${error.message}; kept ${kept}\n`,
    );
  }
  return installed;
}

module.exports = { installClis, installAgy };
