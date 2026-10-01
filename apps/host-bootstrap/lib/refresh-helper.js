"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { hostInstallDir, readHostInstallPins } = require("./host-install-pins");

const NPM_INSTALL_TIMEOUT_MS = 15 * 60_000;
const CLIS_HELPER_TIMEOUT_MS = 45 * 60_000;

async function refreshHelper(version, sys) {
  const archive = path.join(
    hostInstallDir(version, sys),
    "devchain-host-bootstrap.tgz",
  );
  const pins = readHostInstallPins(version, sys);
  let contents;
  try {
    contents = fs.readFileSync(archive);
  } catch (error) {
    throw new Error(
      `Cannot read bootstrap helper for DevChain ${version}: ${error.message}`,
    );
  }
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== pins?.bootstrap?.sha256) {
    throw new Error(
      `Bootstrap helper SHA-256 mismatch for DevChain ${version}.`,
    );
  }
  await sys.run(
    "npm",
    [
      "install",
      "-g",
      `--prefix=${sys.paths.cliPrefix}`,
      "--omit=dev",
      "--no-fund",
      "--no-audit",
      "--ignore-scripts",
      archive,
    ],
    { timeoutMs: NPM_INSTALL_TIMEOUT_MS },
  );
}

async function runClisHelper(version, sys) {
  const { stdout } = await sys.run(
    path.join(sys.paths.binDir, "devchain-host-update"),
    ["--clis", version],
    { timeoutMs: CLIS_HELPER_TIMEOUT_MS },
  );
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new Error("CLI helper returned invalid JSON.");
  }
  if (
    !result?.cliVersions ||
    typeof result.cliVersions !== "object" ||
    Array.isArray(result.cliVersions) ||
    Object.values(result.cliVersions).some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  ) {
    throw new Error("CLI helper returned invalid cliVersions.");
  }
  return result.cliVersions;
}

module.exports = {
  refreshHelper,
  runClisHelper,
  NPM_INSTALL_TIMEOUT_MS,
  CLIS_HELPER_TIMEOUT_MS,
};
