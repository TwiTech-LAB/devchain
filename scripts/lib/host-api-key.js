const fs = require("node:fs");
const { basename, dirname, isAbsolute, join } = require("node:path");
const { userInfo } = require("node:os");
const { randomBytes, createHash } = require("node:crypto");

const CLAIM_FILE = "claim.json";
const KEY_DIR_NAME = ".devchain";
const KEY_FILE_NAME = "host-api-key";
const KEY_PREFIX = "dck_";

function readClaimRecord(claimFile, expectedUser) {
  let raw;
  try {
    raw = fs.readFileSync(claimFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const claim = JSON.parse(raw);
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    throw new Error(`${claimFile} is not a valid claim record.`);
  }
  const { userName, homePath } = claim;
  if (typeof userName !== "string" || userName.length === 0) {
    throw new Error(`${claimFile} has no userName.`);
  }
  if (expectedUser && userName !== expectedUser) {
    throw new Error(
      `${claimFile} does not match instance user "${expectedUser}".`,
    );
  }
  if (typeof homePath !== "string" || !isAbsolute(homePath)) {
    throw new Error(`${claimFile} has no homePath.`);
  }
  return { userName, homePath };
}

function readInstanceClaims(env) {
  const etcDir = env.DEVCHAIN_HOST_ETC_DIR || "/etc/devchain-host";
  const registryDir =
    basename(dirname(etcDir)) === "instances"
      ? dirname(dirname(etcDir))
      : etcDir;
  const legacy = readClaimRecord(join(registryDir, CLAIM_FILE));
  const claims = legacy ? [legacy] : [];
  let dirs;
  try {
    dirs = fs.readdirSync(join(registryDir, "instances"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") return claims;
    throw error;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^[a-z_][a-z0-9_-]{0,31}$/.test(dir.name)) {
      throw new Error("Invalid instance registry directory.");
    }
    const claim = readClaimRecord(
      join(registryDir, "instances", dir.name, CLAIM_FILE),
      dir.name,
    );
    if (claim) claims.push(claim);
  }
  return claims;
}

function lookupUnixAccount(userName) {
  const passwd = fs.readFileSync("/etc/passwd", "utf8");
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === userName) {
      return { uid: Number(fields[2]), gid: Number(fields[3]) };
    }
  }
  return null;
}

function generateHostApiKey() {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

function hashHostApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

// lstat instead of existsSync so a dangling symlink is still refused.
function isSymbolicLink(filePath) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return stats.isSymbolicLink();
}

function runHostApiKeyReset({
  env = process.env,
  getuid = process.getuid,
  getUserInfo = userInfo,
  lookupAccount = lookupUnixAccount,
  chownSync = fs.chownSync,
  log = console.log,
  error = console.error,
} = {}) {
  if (typeof getuid !== "function") {
    error("This command requires a Unix-like system.");
    return 1;
  }
  const uid = getuid();
  let caller;
  let claims;
  try {
    // sudo changes the process user; the SSH caller still selects the instance.
    caller =
      uid === 0 && env.SUDO_USER ? env.SUDO_USER : getUserInfo().username;
    claims = readInstanceClaims(env);
  } catch (err) {
    error(`Cannot read the claim record: ${err.message}`);
    return 1;
  }
  if (claims.length === 0) {
    error("This machine is not a claimed DevChain VM.");
    return 1;
  }
  const claim = claims.find((record) => record.userName === caller);
  if (!claim) {
    const instanceUsers = claims
      .map((record) => record.userName)
      .sort()
      .join(", ");
    error(
      `No DevChain instance belongs to "${caller}". Instance users: ${instanceUsers}. Run this command as an instance user, with sudo if needed.`,
    );
    return 1;
  }
  const { userName, homePath } = claim;

  const account = lookupAccount(userName);
  if (!account) {
    error(`Cannot find the claimed user account "${userName}".`);
    return 1;
  }

  if (uid !== account.uid && uid !== 0) {
    error(
      `This command must run as ${userName} (the claimed user) or as root.`,
    );
    return 1;
  }

  const keyDir = join(homePath, KEY_DIR_NAME);
  const keyFile = join(keyDir, KEY_FILE_NAME);
  try {
    if (isSymbolicLink(keyFile)) {
      error(`Refusing to write ${keyFile}: it is a symbolic link.`);
      return 1;
    }
    let createdKeyDir = false;
    if (!fs.existsSync(keyDir)) {
      fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
      createdKeyDir = true;
    }
    if (uid === 0 && createdKeyDir) {
      // A root-owned 0700 directory would keep the claimed user's server
      // from reading the key file that lives inside it.
      chownSync(keyDir, account.uid, account.gid);
    }
    const key = generateHostApiKey();
    const tmpFile = join(
      keyDir,
      `.${KEY_FILE_NAME}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    fs.writeFileSync(tmpFile, `${hashHostApiKey(key)}\n`, { mode: 0o600 });
    try {
      // Chown before the rename so the key never sits at the final path
      // owned by root.
      if (uid === 0) chownSync(tmpFile, account.uid, account.gid);
      fs.renameSync(tmpFile, keyFile);
    } catch (err) {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {
        // best-effort cleanup of the abandoned temp file
      }
      throw err;
    }
    log(key);
    log("Paste this key on home: Remote VMs → <VM> → Enter API key.");
    return 0;
  } catch (err) {
    error(`Failed to write the host API key: ${err.message}`);
    return 1;
  }
}

module.exports = { runHostApiKeyReset };
