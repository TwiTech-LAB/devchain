"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { BootstrapError } = require("./validate");

/** The host-install inputs that the installed CLI of `version` ships. */
function hostInstallDir(version, sys) {
  return path.join(
    sys.paths.installRoot,
    "versions",
    version,
    "lib/node_modules/devchain-cli/dist/host-install",
  );
}

function readHostInstallPins(version, sys) {
  const file = path.join(hostInstallDir(version, sys), "pins.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read bootstrap helper for DevChain ${version}: ${error.message}`,
    );
  }
}

/** The instance layout this helper serves; scripts/copy-cli.js writes it into pins.json. */
const SHARED_VM_PROTOCOL = 1;

/**
 * Refuses a target version whose helper predates instances. Its helper would
 * resolve the legacy paths, so a joined instance must never install it.
 */
function assertSharedVmTarget(version, pins) {
  if (pins?.sharedVmProtocol === SHARED_VM_PROTOCOL) return;
  throw new BootstrapError(
    409,
    "SHARED_VM_UNSUPPORTED",
    `DevChain ${version} does not support shared VMs. This instance keeps its current version.`,
  );
}

module.exports = {
  hostInstallDir,
  readHostInstallPins,
  assertSharedVmTarget,
  SHARED_VM_PROTOCOL,
};
