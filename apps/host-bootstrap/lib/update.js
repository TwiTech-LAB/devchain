"use strict";

const path = require("node:path");
const { BootstrapError, isSemver } = require("./validate");
const { refreshHelper, runClisHelper } = require("./refresh-helper");
const {
  requireClaim,
  jobStatus,
  readManifest,
  installVersion,
  activateVersion,
  removeOtherVersions,
  writeFileAtomic,
  claimFile,
} = require("./claim");

const UPDATE_UNIT = "devchain-host-update";
const UPDATE_RESTART_TIMEOUT_MS = 120_000;

const status = (sys) => jobStatus(sys, "update.json");
const statusFile = (sys) => status(sys).file;
const writeStatus = (sys, value) => status(sys).write(value);
const readStatus = (sys) => status(sys).read();

/**
 * Starts the update in its own transient unit and returns. The update
 * restarts devchain-host.service, whose cgroup the caller (DevChain, through
 * sudo) belongs to, so it must not run there.
 */
async function requestUpdate(version, sys) {
  if (!isSemver(version))
    throw new BootstrapError(
      400,
      "INVALID_VERSION",
      "version must be a semantic version.",
    );
  requireClaim(sys);
  try {
    await sys.run("systemd-run", [
      `--unit=${UPDATE_UNIT}`,
      "--collect",
      "--no-block",
      "--quiet",
      path.join(sys.paths.binDir, "devchain-host-update"),
      "--run",
      version,
    ]);
  } catch (error) {
    throw new BootstrapError(
      409,
      "UPDATE_IN_PROGRESS",
      `Could not start the update: ${error.message}`,
    );
  }
  writeStatus(sys, { state: "pending", version });
}

/**
 * The update itself: install beside the running version, switch, record,
 * restart, then remove the old version. Progress goes to update.json.
 */
async function runUpdate(version, sys) {
  if (!isSemver(version))
    throw new BootstrapError(
      400,
      "INVALID_VERSION",
      "version must be a semantic version.",
    );
  const claim = requireClaim(sys);
  if (version === claim.version) {
    writeStatus(sys, { state: "done", version });
    return;
  }
  try {
    writeStatus(sys, { state: "installing", version });
    const { npmRegistry } = readManifest(sys);
    await installVersion(version, npmRegistry, sys);
    await refreshHelper(version, sys);
    writeStatus(sys, { state: "installing_clis", version });
    const cliVersions = await runClisHelper(version, sys);
    activateVersion(version, sys);
    writeFileAtomic(
      claimFile(sys),
      `${JSON.stringify({ ...claim, version, cliVersions }, null, 2)}\n`,
      0o644,
      null,
      sys,
    );
    writeStatus(sys, { state: "restarting", version });
    await sys.run("systemctl", ["restart", "devchain-host.service"], {
      timeoutMs: UPDATE_RESTART_TIMEOUT_MS,
    });
    removeOtherVersions(version, sys);
    writeStatus(sys, { state: "done", version });
  } catch (error) {
    writeStatus(sys, { state: "failed", version, error: error.message });
    throw error;
  }
}

module.exports = { requestUpdate, runUpdate, readStatus, statusFile };
