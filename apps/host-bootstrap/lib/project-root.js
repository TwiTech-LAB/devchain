"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { BootstrapError, isPlainAbsolutePath, isInside } = require("./validate");
const { readClaim } = require("./claim");

/** Never a project root, nor anything under them. */
const SYSTEM_DIRS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/lost+found",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/snap",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
];
/** Homes live here; only the claimed user's own home is usable. */
const HOME_ROOTS = ["/home", "/Users", "/var/home"];

const refuse = (message) => new BootstrapError(403, "PATH_REFUSED", message);

function within(target, dir) {
  return target === dir || isInside(target, dir);
}

/** /var/home is a home root although it lives under the system dir /var. */
function isSystemDir(target) {
  return (
    SYSTEM_DIRS.some((dir) => within(target, dir)) &&
    !HOME_ROOTS.some((root) => within(target, root))
  );
}

async function checkTarget(target, owner, sys) {
  if (target === "/" || isSystemDir(target)) {
    throw refuse(`${target} is a system directory.`);
  }
  if (within(target, owner.home)) return;
  if (HOME_ROOTS.some((root) => within(target, root))) {
    throw refuse(
      `${target} is under a home directory that is not ${owner.home}.`,
    );
  }
  const users = await sys.listUsers();
  const other = users.find(
    (user) =>
      user.name !== owner.name &&
      user.home !== "/" &&
      within(target, user.home),
  );
  if (other) throw refuse(`${target} is under the home of ${other.name}.`);
}

/** `target` with its deepest existing ancestor resolved through symlinks. */
function resolveExisting(target) {
  let existing = target;
  const rest = [];
  while (!fs.existsSync(existing)) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

/**
 * Creates a project root for the claimed user. Outside the user's home, the
 * missing parents belong to root and only the root itself to the user.
 */
async function createProjectRoot(target, sys) {
  const claim = readClaim(sys);
  if (!claim)
    throw new BootstrapError(409, "NOT_CLAIMED", "This VM is not claimed.");
  const owner = await sys.lookupUser(claim.userName);
  if (!owner)
    throw new BootstrapError(
      409,
      "NOT_CLAIMED",
      `User ${claim.userName} is missing.`,
    );
  owner.name = claim.userName;
  if (!isPlainAbsolutePath(target)) {
    throw new BootstrapError(
      400,
      "INVALID_PATH",
      "path must be a plain absolute path.",
    );
  }
  await checkTarget(target, owner, sys);
  const real = resolveExisting(target);
  if (real !== target) await checkTarget(real, owner, sys);

  if (fs.existsSync(real)) {
    const stat = fs.statSync(real);
    if (!stat.isDirectory() || stat.uid !== owner.uid) {
      throw new BootstrapError(
        409,
        "PATH_EXISTS",
        `${target} exists and is not the user's directory.`,
      );
    }
    return { path: target, created: false };
  }

  const inHome = within(real, owner.home);
  let current = "/";
  for (const segment of real.split("/").slice(1)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) continue;
    fs.mkdirSync(current, { mode: 0o755 });
    fs.chmodSync(current, 0o755);
    if (inHome || current === real) sys.chown(current, owner.uid, owner.gid);
  }
  return { path: target, created: true };
}

module.exports = { createProjectRoot, checkTarget };
