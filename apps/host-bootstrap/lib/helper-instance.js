"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { readClaim } = require("./claim");
const { readRegistry, requireReservation } = require("./instances");
const { BootstrapError, USER_NAME, MIN_CLAIM_UID } = require("./validate");

/** Validates the installed helper's own account before any privileged work. */
async function requireHelperInstance(
  sys,
  { sudoUser = process.env.SUDO_USER, allowClaiming = false } = {},
) {
  let identity = readClaim(sys);
  if (!identity && allowClaiming && sys.paths.instanceUser) {
    identity = await requireReservation(sys);
    if (!identity.claimStartedAt)
      throw new BootstrapError(
        409,
        "NOT_CLAIMED",
        "The instance claim has not started.",
      );
  }
  if (!identity && allowClaiming && !sys.paths.instanceUser) {
    const file = path.join(sys.paths.sudoersDir, sys.paths.sudoersName);
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isFile()) {
      const { stdout } = await sys.run("stat", ["-c", "%u:%a", "--", file]);
      const [owner, mode] = stdout.trim().split(":");
      if (
        owner !== "0" ||
        !/^[0-7]{3,4}$/.test(mode) ||
        parseInt(mode, 8) & 0o022
      )
        throw new BootstrapError(
          409,
          "INSTANCE_MISMATCH",
          "The instance sudoers file must be root-owned and not writable by group or others.",
        );
      const contents = await fs.readFile(file, "utf8");
      const userName = contents.match(
        /^([a-z_][a-z0-9_-]{0,31}) ALL=\(ALL\) NOPASSWD:ALL$/m,
      )?.[1];
      identity = userName ? { userName } : null;
    }
  }
  if (!identity)
    throw new BootstrapError(
      409,
      "NOT_CLAIMED",
      "This instance is not claimed.",
    );
  if (
    typeof identity.userName !== "string" ||
    !USER_NAME.test(identity.userName) ||
    (sys.paths.instanceUser && identity.userName !== sys.paths.instanceUser)
  )
    throw new BootstrapError(
      409,
      "INSTANCE_MISMATCH",
      "The account does not match this helper's instance.",
    );
  const account = await sys.lookupUser(identity.userName);
  if (
    !account ||
    account.name !== identity.userName ||
    !Number.isInteger(account.uid) ||
    account.uid < MIN_CLAIM_UID ||
    (identity.homePath && account.home !== identity.homePath)
  )
    throw new BootstrapError(
      409,
      "INSTANCE_MISMATCH",
      "The instance account is missing or does not match its claim.",
    );
  if (sudoUser && sudoUser !== identity.userName) {
    const registry = await readRegistry(sys);
    if (
      registry.some(
        (entry) => (entry.claim ?? entry.join).userName === sudoUser,
      )
    )
      throw new BootstrapError(
        409,
        "INSTANCE_MISMATCH",
        "The sudo caller belongs to another DevChain instance.",
      );
  }
  return identity;
}

module.exports = { requireHelperInstance };
