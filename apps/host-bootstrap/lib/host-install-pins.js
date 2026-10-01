"use strict";

const fs = require("node:fs");
const path = require("node:path");

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

module.exports = { hostInstallDir, readHostInstallPins };
