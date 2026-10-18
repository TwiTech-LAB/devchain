"use strict";

const path = require("node:path");
const { BootstrapError, isSemver, validateRegistry } = require("./validate");
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

const UPDATE_RESTART_TIMEOUT_MS = 120_000;

const status = (sys) => jobStatus(sys, "update.json");
const statusFile = (sys) => status(sys).file;
const writeStatus = (sys, value) => status(sys).write(value);
const readStatus = (sys) => status(sys).read();

/**
 * Starts the update in its own transient unit and returns. The update
 * restarts the instance service, whose cgroup the caller (DevChain, through
 * sudo) belongs to, so it must not run there.
 */
async function requestUpdate(version, sys, registry) {
  if (!isSemver(version))
    throw new BootstrapError(
      400,
      "INVALID_VERSION",
      "version must be a semantic version.",
    );
  if (registry !== undefined) validateRegistry(registry);
  requireClaim(sys);
  try {
    await sys.run("systemd-run", [
      `--unit=${sys.paths.updateUnitName}`,
      "--collect",
      "--no-block",
      "--quiet",
      path.join(sys.paths.binDir, "devchain-host-update"),
      "--run",
      version,
      ...(registry !== undefined ? ["--registry", registry] : []),
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
 * DevChain installs from `registry`, else from the manifest's registry.
 */
async function runUpdate(version, sys, registry) {
  if (!isSemver(version))
    throw new BootstrapError(
      400,
      "INVALID_VERSION",
      "version must be a semantic version.",
    );
  if (registry !== undefined) validateRegistry(registry);
  const claim = requireClaim(sys);
  if (version === claim.version) {
    writeStatus(sys, { state: "done", version });
    return;
  }
  try {
    writeStatus(sys, { state: "installing", version });
    await installVersion(
      version,
      registry ?? readManifest(sys).npmRegistry,
      sys,
    );
    await refreshHelper(version, sys);
    writeStatus(sys, { state: "installing_clis", version });
    const cliVersions = await runClisHelper(version, sys);
    activateVersion(version, sys);
    await sys.withHostLock(async () => {
      writeFileAtomic(
        claimFile(sys),
        `${JSON.stringify({ ...claim, version, cliVersions }, null, 2)}\n`,
        0o644,
        null,
        sys,
      );
    });
    writeStatus(sys, { state: "restarting", version });
    await sys.run("systemctl", ["restart", sys.paths.unitName], {
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
