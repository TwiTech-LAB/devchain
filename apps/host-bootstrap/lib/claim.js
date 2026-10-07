"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { BootstrapError, MIN_CLAIM_UID, MAX_CLAIM_UID } = require("./validate");
const { renderEnvFile, renderHostUnit, renderSudoers } = require("./render");
const { loadTls, userTlsFiles, TLS_KEY_ENV, TLS_CERT_ENV } = require("./tls");
const {
  refreshHelper,
  runClisHelper,
  NPM_INSTALL_TIMEOUT_MS,
} = require("./refresh-helper");

function claimFile(sys) {
  return path.join(sys.paths.etcDir, "claim.json");
}

function readClaim(sys) {
  try {
    return JSON.parse(fs.readFileSync(claimFile(sys), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readManifest(sys) {
  return JSON.parse(fs.readFileSync(sys.paths.manifestFile, "utf8"));
}

/** Writes via a temp file and rename, so a reader never sees half a file. */
function writeFileAtomic(file, content, mode, owner, sys) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, content, { mode, flag: "wx" });
  fs.chmodSync(tmp, mode);
  if (owner) sys.chown(tmp, owner.uid, owner.gid);
  fs.renameSync(tmp, file);
}

function refuseSymlink(target) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new BootstrapError(
        409,
        "SYMLINK_REFUSED",
        `${target} is a symbolic link.`,
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/** Creates the missing directories between `home` and `dir` as the user, mode 0700. */
function ensureUserDir(dir, account, sys) {
  const relative = path.relative(account.home, dir);
  let current = account.home;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    refuseSymlink(current);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
      fs.chmodSync(current, 0o700);
      sys.chown(current, account.uid, account.gid);
    }
  }
}

function writeUserFile(file, content, mode, account, sys) {
  ensureUserDir(path.dirname(file), account, sys);
  refuseSymlink(file);
  writeFileAtomic(file, content, mode, account, sys);
}

function ensureIdsProfile(sys) {
  const file = path.join(sys.paths.profileDir, "devchain-ids.sh");
  const content = 'export DEVCHAIN_UID="$(id -u)" DEVCHAIN_GID="$(id -g)"\n';
  fs.mkdirSync(sys.paths.profileDir, { recursive: true, mode: 0o755 });
  refuseSymlink(file);
  try {
    const stat = fs.statSync(file);
    if (
      fs.readFileSync(file, "utf8") === content &&
      (stat.mode & 0o777) === 0o644
    )
      return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeFileAtomic(file, content, 0o644, null, sys);
  return true;
}

async function ensureUser(claim, sys) {
  const requestedUid =
    Number.isInteger(claim.uid) &&
    claim.uid >= MIN_CLAIM_UID &&
    claim.uid <= MAX_CLAIM_UID
      ? claim.uid
      : undefined;
  const holder =
    requestedUid === undefined ? null : await sys.lookupUid(requestedUid);
  const existing = await sys.lookupUser(claim.userName);
  if (existing) {
    if (
      existing.uid < MIN_CLAIM_UID ||
      (existing.uid < 1000 && existing.uid !== requestedUid) ||
      existing.home !== claim.homePath
    ) {
      throw new BootstrapError(
        409,
        "USER_EXISTS",
        `User ${claim.userName} already exists with another home or as a system account.`,
      );
    }
    return accountIdentity(existing, claim, requestedUid, holder, sys);
  }
  if (fs.existsSync(claim.homePath)) {
    throw new BootstrapError(
      409,
      "HOME_EXISTS",
      `${claim.homePath} already exists.`,
    );
  }
  // useradd creates the home but not its parent (/Users on a Linux VM).
  fs.mkdirSync(path.dirname(claim.homePath), { recursive: true, mode: 0o755 });
  const group = await ensurePrimaryGroup(claim, requestedUid, holder, sys);
  const useraddArgs = [
    "-m",
    "-d",
    claim.homePath,
    "-s",
    "/bin/bash",
    "-g",
    String(group.gid),
  ];
  if (requestedUid !== undefined && holder === null) {
    useraddArgs.push("-u", String(requestedUid));
  }
  useraddArgs.push(claim.userName);
  await sys.run("useradd", useraddArgs);
  const created = await sys.lookupUser(claim.userName);
  if (!created) throw new Error(`useradd did not create ${claim.userName}`);
  return accountIdentity(created, claim, requestedUid, holder, sys);
}

async function ensurePrimaryGroup(claim, requestedUid, holder, sys) {
  let gid = claim.gid;
  if (gid !== undefined) {
    const existing = await sys.lookupGroup(gid);
    if (existing) return existing;
  } else {
    const existing = await sys.lookupGroup(claim.userName);
    if (existing) return existing;
    // Preserve uid-only claims' private-group ids when that number is free.
    if (
      requestedUid !== undefined &&
      holder === null &&
      !(await sys.lookupGroup(requestedUid))
    ) {
      gid = requestedUid;
    }
  }
  let name = claim.userName;
  for (let suffix = 1; await sys.lookupGroup(name); suffix += 1) {
    const tail = `-${suffix}`;
    name = `${claim.userName.slice(0, 32 - tail.length)}${tail}`;
  }
  await sys.run("groupadd", [
    ...(gid === undefined ? [] : ["-g", String(gid)]),
    name,
  ]);
  const group = await sys.lookupGroup(name);
  if (!group) throw new Error(`groupadd did not create ${name}`);
  return group;
}

async function accountIdentity(account, claim, requestedUid, holder, sys) {
  const primaryGroup = (
    await sys.run("id", ["-gn", account.name])
  ).stdout.trim();
  const mismatch =
    requestedUid !== undefined &&
    (account.uid !== requestedUid ||
      (claim.gid !== undefined && account.gid !== claim.gid));
  return {
    ...account,
    primaryGroup,
    ...(mismatch
      ? {
          uidConflict: {
            requestedUid,
            holder: holder && holder.name !== account.name ? holder.name : null,
          },
        }
      : {}),
  };
}

async function writeSudoers(userName, sys) {
  const file = path.join(sys.paths.sudoersDir, "devchain-host");
  const tmp = `${file}.new`;
  fs.writeFileSync(tmp, renderSudoers(userName, sys.paths.binDir), {
    mode: 0o440,
  });
  fs.chmodSync(tmp, 0o440);
  try {
    await sys.run("visudo", ["-cf", tmp]);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fs.renameSync(tmp, file);
}

/** DevChain serves the same certificate the bootstrap served, from the user's own copy. */
function copyTls(claim, account, sys) {
  const { key, cert } = loadTls(sys);
  const files = userTlsFiles(claim.homePath);
  writeUserFile(files.key, key, 0o600, account, sys);
  writeUserFile(files.cert, cert, 0o600, account, sys);
}

function writeProviderAuth(claim, account, sys) {
  const tls = userTlsFiles(claim.homePath);
  writeUserFile(
    path.join(claim.homePath, ".devchain", "host.env"),
    renderEnvFile({
      ...claim.env,
      [TLS_KEY_ENV]: tls.key,
      [TLS_CERT_ENV]: tls.cert,
    }),
    0o600,
    account,
    sys,
  );
  for (const file of claim.files) {
    writeUserFile(file.path, file.content, file.mode, account, sys);
  }
}

function versionsDir(sys) {
  return path.join(sys.paths.installRoot, "versions");
}

/**
 * Installs `devchain-cli@<version>` into its own prefix and checks the CLI
 * reports it. The active version is untouched until `activateVersion`, so an
 * interrupted install never breaks the running DevChain.
 */
async function installVersion(version, registry, sys) {
  const prefix = path.join(versionsDir(sys), version);
  fs.rmSync(prefix, { recursive: true, force: true });
  fs.mkdirSync(prefix, { recursive: true, mode: 0o755 });
  await sys.run(
    "npm",
    [
      "install",
      "-g",
      "--no-fund",
      "--no-audit",
      `--prefix=${prefix}`,
      `--registry=${registry}`,
      `devchain-cli@${version}`,
    ],
    { timeoutMs: NPM_INSTALL_TIMEOUT_MS },
  );
  const { stdout } = await sys.run(path.join(prefix, "bin", "devchain"), [
    "--version",
  ]);
  if (stdout.trim() !== version) {
    throw new Error(
      `devchain --version reports ${stdout.trim()}, expected ${version}`,
    );
  }
}

function replaceSymlink(link, target) {
  const tmp = `${link}.new`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

/**
 * Makes `version` the one `<binDir>/devchain` runs, with one rename each:
 * `<installRoot>/current` -> `versions/<version>`, and the bin link through it.
 */
function activateVersion(version, sys) {
  const current = path.join(sys.paths.installRoot, "current");
  replaceSymlink(current, path.join("versions", version));
  replaceSymlink(
    path.join(sys.paths.binDir, "devchain"),
    path.join(current, "bin", "devchain"),
  );
}

function removeOtherVersions(version, sys) {
  for (const entry of fs.readdirSync(versionsDir(sys))) {
    if (entry !== version)
      fs.rmSync(path.join(versionsDir(sys), entry), {
        recursive: true,
        force: true,
      });
  }
}

async function writeHostUnit(claim, account, sys, unitTemplate) {
  const groupName = (
    await sys.run("id", ["-gn", claim.userName])
  ).stdout.trim();
  const unit = renderHostUnit(unitTemplate, {
    userName: claim.userName,
    groupName,
    homePath: account.home,
    port: claim.port,
    binDir: sys.paths.binDir,
  });
  writeFileAtomic(
    path.join(sys.paths.systemdDir, "devchain-host.service"),
    unit,
    0o644,
    null,
    sys,
  );
  await sys.run("systemctl", ["daemon-reload"]);
  await sys.run("systemctl", ["enable", "devchain-host.service"]);
}

/**
 * Re-writes devchain-host.service from the current helper's template so a
 * version-changing Update VM picks up template changes. The record is the
 * source of user, home, and port; without one (a claim, or its retry before
 * the record step) the claim's own `service` step owns the write, so this
 * does nothing. Returns whether the unit was written.
 */
async function refreshHostUnit(sys) {
  const claim = readClaim(sys);
  if (!claim) return false;
  const unitTemplate = fs.readFileSync(sys.paths.unitTemplate, "utf8");
  await writeHostUnit(claim, { home: claim.homePath }, sys, unitTemplate);
  return true;
}

function writeClaimRecord(claim, account, cliVersions, sys) {
  fs.mkdirSync(sys.paths.etcDir, { recursive: true, mode: 0o755 });
  const record = {
    userName: claim.userName,
    homePath: claim.homePath,
    ...(claim.uid !== undefined ? { requestedUid: claim.uid } : {}),
    ...(claim.gid !== undefined ? { requestedGid: claim.gid } : {}),
    uid: account.uid,
    gid: account.gid,
    primaryGroup: account.primaryGroup,
    ...(account.uidConflict ? { uidConflict: account.uidConflict } : {}),
    version: claim.version,
    cliVersions,
    port: claim.port,
    claimedAt: sys.now().toISOString(),
  };
  writeFileAtomic(
    claimFile(sys),
    `${JSON.stringify(record, null, 2)}\n`,
    0o644,
    null,
    sys,
  );
  return record;
}

/**
 * Every step before the claim record is safe to repeat, so a claim that
 * failed part way can be sent again. The claim record is written last.
 */
async function performClaim(claim, sys, log) {
  if (readClaim(sys)) {
    throw new BootstrapError(
      409,
      "ALREADY_CLAIMED",
      "This VM is already claimed.",
    );
  }
  const { npmRegistry } = readManifest(sys);
  const unitTemplate = fs.readFileSync(sys.paths.unitTemplate, "utf8");
  let cliVersions = null;
  const steps = [
    ["user", () => ensureUser(claim, sys)],
    ["sudoers", () => writeSudoers(claim.userName, sys)],
    ["profile", () => ensureIdsProfile(sys)],
    ["tls", (account) => copyTls(claim, account, sys)],
    ["provider-auth", (account) => writeProviderAuth(claim, account, sys)],
    ["install", () => installVersion(claim.version, npmRegistry, sys)],
    ["helper", () => refreshHelper(claim.version, sys)],
    ["clis", () => runClisHelper(claim.version, sys)],
    ["activate", () => activateVersion(claim.version, sys)],
    ["service", (account) => writeHostUnit(claim, account, sys, unitTemplate)],
    ["record", (account) => writeClaimRecord(claim, account, cliVersions, sys)],
  ];
  let account = null;
  let record = null;
  for (const [name, fn] of steps) {
    log("info", "claim step", { step: name });
    try {
      const result = await fn(account);
      if (name === "user") account = result;
      if (name === "clis") cliVersions = result;
      if (name === "record") record = result;
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      const failed = new BootstrapError(
        500,
        "CLAIM_STEP_FAILED",
        `Claim step "${name}" failed: ${error.message}`,
      );
      failed.step = name;
      throw failed;
    }
  }
  return record;
}

/** The claim, or 409 NOT_CLAIMED when this VM has none. */
function requireClaim(sys) {
  const claim = readClaim(sys);
  if (!claim)
    throw new BootstrapError(409, "NOT_CLAIMED", "This VM is not claimed.");
  return claim;
}

/** A detached job's JSON status file in etcDir: `read` gives null when absent or unreadable. */
function jobStatus(sys, fileName) {
  const file = path.join(sys.paths.etcDir, fileName);
  return {
    file,
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    write(status) {
      writeFileAtomic(
        file,
        `${JSON.stringify({ ...status, at: sys.now().toISOString() }, null, 2)}\n`,
        0o644,
        null,
        sys,
      );
    },
  };
}

module.exports = {
  performClaim,
  ensureIdsProfile,
  readClaim,
  requireClaim,
  refreshHostUnit,
  jobStatus,
  readManifest,
  installVersion,
  activateVersion,
  removeOtherVersions,
  writeFileAtomic,
  claimFile,
};
