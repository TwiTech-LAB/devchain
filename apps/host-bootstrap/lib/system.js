"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { withFileLock } = require("./host-lock");

/** Where the bootstrap reads and writes; tests point these at a temp directory. */
const DEFAULT_PATHS = {
  etcDir: "/etc/devchain-host",
  profileDir: "/etc/profile.d",
  tlsDir: "/etc/devchain-host/tls",
  osReleaseFile: "/etc/os-release",
  aptDir: "/etc/apt",
  manifestFile: "/usr/share/devchain-host/manifest.json",
  systemdDir: "/etc/systemd/system",
  sudoersDir: "/etc/sudoers.d",
  binDir: "/usr/local/bin",
  cliPrefix: "/usr/local",
  installRoot: "/opt/devchain-host",
  syncthingBinary: "/usr/bin/syncthing",
  unitTemplate: require.resolve("../systemd/devchain-host.service"),
  unitName: "devchain-host.service",
  sudoersName: "devchain-host",
  updateUnitName: "devchain-host-update",
  dockerUnitName: "devchain-host-docker",
};

/** The bootstrap package inside an npm global prefix. */
function helperPackageDir(prefix) {
  return path.join(prefix, "lib/node_modules/devchain-host-bootstrap");
}

/** Points `link` at `target` with one rename, so a reader never sees it missing. */
function replaceSymlink(link, target) {
  const tmp = `${link}.new`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

class CommandError extends Error {
  constructor(command, detail) {
    super(`${command} failed: ${detail}`);
    this.command = command;
  }
}

/**
 * Runs a command without a shell. Arguments never carry credentials, so the
 * error keeps the tail of stderr for diagnosis.
 */
function run(command, args, { timeoutMs = 60_000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr || error.message)
            .trim()
            .split("\n")
            .slice(-5)
            .join(" | ");
          reject(new CommandError(`${command} ${args[0] ?? ""}`.trim(), tail));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function parsePasswdLine(line) {
  const [name, , uid, gid, , home] = line.split(":");
  return { name, uid: Number(uid), gid: Number(gid), home };
}

/** The account named `name`, or null. */
async function lookupUser(name) {
  try {
    const { stdout } = await run("getent", ["passwd", name]);
    const line = stdout.trim().split("\n")[0];
    return line ? parsePasswdLine(line) : null;
  } catch {
    return null;
  }
}

/** The account holding `uid`, or null when the uid is free. */
async function lookupUid(uid) {
  try {
    const { stdout } = await run("getent", ["passwd", String(uid)]);
    const line = stdout.trim().split("\n")[0];
    return line ? parsePasswdLine(line) : null;
  } catch {
    return null;
  }
}

async function lookupGroup(nameOrGid) {
  try {
    const { stdout } = await run("getent", ["group", String(nameOrGid)]);
    const line = stdout.trim().split("\n")[0];
    if (!line) return null;
    const [name, , gid] = line.split(":");
    return { name, gid: Number(gid) };
  } catch {
    return null;
  }
}

async function listUsers() {
  const { stdout } = await run("getent", ["passwd"]);
  return stdout.trim().split("\n").filter(Boolean).map(parsePasswdLine);
}

function createSystem(overrides = {}) {
  const paths = { ...DEFAULT_PATHS, ...overrides.paths };
  paths.registryDir ??= paths.etcDir;
  paths.hostInstallRoot ??= paths.installRoot;
  paths.helperPrefix ??= paths.cliPrefix;
  return {
    paths,
    withHostLock:
      overrides.withHostLock ??
      ((action) =>
        withFileLock(path.join(paths.registryDir, "registry.lock"), action)),
    run: overrides.run ?? run,
    lookupUser: overrides.lookupUser ?? lookupUser,
    lookupUid: overrides.lookupUid ?? lookupUid,
    lookupGroup: overrides.lookupGroup ?? lookupGroup,
    listUsers: overrides.listUsers ?? listUsers,
    chown:
      overrides.chown ?? ((file, uid, gid) => fs.lchownSync(file, uid, gid)),
    fetch: overrides.fetch ?? globalThis.fetch,
    now: overrides.now ?? (() => new Date()),
    sleep:
      overrides.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** A joined instance never inherits a sibling's mutable paths. */
function createInstanceSystem(sys, userName) {
  const { USER_NAME, BootstrapError } = require("./validate");
  if (typeof userName !== "string" || !USER_NAME.test(userName))
    throw new BootstrapError(
      400,
      "INVALID_INSTANCE",
      "Invalid instance user name.",
    );
  const installRoot = path.join(
    sys.paths.hostInstallRoot,
    "instances",
    userName,
  );
  return {
    ...sys,
    paths: {
      ...sys.paths,
      instanceUser: userName,
      etcDir: path.join(sys.paths.registryDir, "instances", userName),
      installRoot,
      helperPrefix: path.join(installRoot, "helper"),
      cliPrefix: path.join(installRoot, "clis"),
      binDir: path.join(installRoot, "bin"),
      unitName: `devchain-user-${userName}.service`,
      joinUnitName: `devchain-join-${userName}.service`,
      sudoersName: `devchain-user-${userName}`,
      updateUnitName: `devchain-update-${userName}`,
      dockerUnitName: `devchain-docker-${userName}`,
    },
  };
}

/** Resolves helper identity from its real npm installation, never from environment variables. */
function createInstalledSystem(
  packageDir = path.resolve(__dirname, ".."),
  sys = createSystem(),
) {
  const own =
    packageDir === helperPackageDir(sys.paths.helperPrefix)
      ? sys
      : createInstanceSystem(sys, instanceOfPackage(packageDir, sys));
  return {
    ...own,
    paths: {
      ...own.paths,
      unitTemplate: path.join(packageDir, "systemd/devchain-host.service"),
    },
  };
}

/** The user whose instance prefix holds `packageDir`. */
function instanceOfPackage(packageDir, sys) {
  const instances = path.join(sys.paths.hostInstallRoot, "instances");
  const [userName] = path.relative(instances, packageDir).split(path.sep);
  if (
    packageDir !==
    helperPackageDir(path.join(instances, userName ?? "", "helper"))
  ) {
    const { BootstrapError } = require("./validate");
    throw new BootstrapError(
      409,
      "INSTANCE_MISMATCH",
      "The helper is not installed in an instance prefix.",
    );
  }
  return userName;
}

module.exports = {
  createSystem,
  createInstanceSystem,
  createInstalledSystem,
  helperPackageDir,
  replaceSymlink,
  CommandError,
  parsePasswdLine,
};
