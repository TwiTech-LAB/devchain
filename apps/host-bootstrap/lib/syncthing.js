"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { USER_NAME, MIN_CLAIM_UID } = require("./validate");
const { claimFile } = require("./claim");

const GRANT = "cap_chown,cap_fowner,cap_dac_override";

const sortedCapabilities = (list) => list.split(",").sort().join(",");
const oneLine = (error) => String(error.message).replace(/[\r\n]+/g, " ");

async function claimedAccount(sys) {
  const claimPath = claimFile(sys);
  let file = claimPath;
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    file = path.join(sys.paths.sudoersDir, sys.paths.sudoersName);
    stat = fs.lstatSync(file);
  }
  if (!stat.isFile()) throw new Error("account file must be a regular file");
  const { stdout } = await sys.run("stat", ["-c", "%u:%a", "--", file]);
  const [owner, mode] = stdout.trim().split(":");
  if (owner !== "0" || !/^[0-7]{3,4}$/.test(mode) || parseInt(mode, 8) & 0o022)
    throw new Error(
      "account file must be root-owned and not writable by group or others",
    );
  const contents = fs.readFileSync(file, "utf8");
  const userName =
    file === claimPath
      ? JSON.parse(contents).userName
      : contents.match(
          /^([a-z_][a-z0-9_-]{0,31}) ALL=\(ALL\) NOPASSWD:ALL$/m,
        )?.[1];
  if (typeof userName !== "string" || !USER_NAME.test(userName))
    throw new Error("no valid claimed account found");
  if (sys.paths.instanceUser && userName !== sys.paths.instanceUser)
    throw new Error("account does not match the instance");
  const account = await sys.lookupUser(userName);
  if (
    !account ||
    account.name !== userName ||
    !Number.isInteger(account.uid) ||
    account.uid < MIN_CLAIM_UID
  )
    throw new Error("claimed account is missing or has a system uid");
  const group = (await sys.run("id", ["-gn", userName])).stdout.trim();
  if (!USER_NAME.test(group))
    throw new Error("claimed account has an invalid primary group");
  return group;
}

async function installPrivilegedSyncthing(sys) {
  const dir = path.join(sys.paths.installRoot, "bin");
  const binary = path.join(dir, "syncthing");
  let staged;
  try {
    const group = await claimedAccount(sys);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    staged = path.join(dir, `.syncthing-${randomUUID()}.new`);
    fs.copyFileSync(
      sys.paths.syncthingBinary,
      staged,
      fs.constants.COPYFILE_EXCL,
    );
    await sys.run("chown", [`root:${group}`, staged]);
    fs.chmodSync(staged, 0o750);
    await sys.run("setcap", [`${GRANT}+ep`, staged]);
    const { stdout } = await sys.run("getcap", [staged]);
    const prefix = `${staged} `;
    const value = stdout.trim();
    const caps = value.startsWith(prefix)
      ? value.slice(prefix.length).split("=")
      : [];
    if (
      caps.length !== 2 ||
      caps[1] !== "ep" ||
      sortedCapabilities(caps[0]) !== sortedCapabilities(GRANT)
    )
      throw new Error("capability verification failed");
    // Replacing a running executable in place fails with ETXTBSY.
    fs.renameSync(staged, binary);
  } catch (error) {
    const failures = [oneLine(error)];
    for (const file of [staged, binary].filter(Boolean)) {
      try {
        fs.rmSync(file, { force: true });
      } catch (cleanupError) {
        failures.push(`cleanup failed: ${oneLine(cleanupError)}`);
      }
    }
    process.stderr.write(
      `privileged Syncthing unavailable: ${failures.join("; ")}\n`,
    );
  }
}

module.exports = { installPrivilegedSyncthing };
