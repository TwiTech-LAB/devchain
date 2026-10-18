"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} = require("node:crypto");
const {
  BootstrapError,
  USER_NAME,
  MIN_CLAIM_UID,
  validateHomePath,
} = require("./validate");
const { createInstanceSystem } = require("./system");
const { renderJoinUnit } = require("./render");
const { claimFile } = require("./claim");
const { assertJoinAllowed } = require("./fence");

const JOIN_TTL_MS = 60 * 60_000;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

const joinFile = (sys) => path.join(sys.paths.etcDir, "join.json");
const nonceFile = (sys) => path.join(sys.paths.etcDir, "join.nonce");
const hashNonce = (nonce) => createHash("sha256").update(nonce).digest("hex");

async function removeJoinFiles(sys) {
  await fs.rm(joinFile(sys), { force: true });
  await fs.rm(nonceFile(sys), { force: true });
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(file, content, mode = 0o600) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tmp, content, { mode, flag: "wx" });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

function instanceExists(record) {
  return new BootstrapError(
    409,
    "INSTANCE_EXISTS",
    `This VM already runs DevChain for ${record.userName} on port ${record.port}.`,
  );
}

function checkIdentity(record, userName) {
  if (
    !record ||
    typeof record.userName !== "string" ||
    !USER_NAME.test(record.userName) ||
    (userName && record.userName !== userName) ||
    typeof record.homePath !== "string" ||
    !Number.isInteger(record.port) ||
    record.port < 1024 ||
    record.port > 65535
  )
    throw new BootstrapError(
      409,
      "INSTANCE_MISMATCH",
      "The instance record does not match its registry entry.",
    );
  return record;
}

/** Legacy claim plus joined claims and reservations; malformed entries fail closed. */
async function readRegistry(sys) {
  const entries = [];
  const legacy = await readJson(path.join(sys.paths.registryDir, "claim.json"));
  if (legacy) entries.push({ claim: checkIdentity(legacy) });
  let dirs;
  try {
    dirs = await fs.readdir(path.join(sys.paths.registryDir, "instances"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") return entries;
    throw error;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || !USER_NAME.test(dir.name))
      throw new BootstrapError(
        409,
        "INSTANCE_MISMATCH",
        "Invalid instance registry directory.",
      );
    const own = createInstanceSystem(sys, dir.name);
    const claim = await readJson(claimFile(own));
    if (claim)
      entries.push({ sys: own, claim: checkIdentity(claim, dir.name) });
    else {
      const join = await readReservation(own);
      if (join) entries.push({ sys: own, join });
    }
  }
  return entries;
}

async function readReservation(sys) {
  if (!sys.paths.instanceUser)
    throw new BootstrapError(
      409,
      "INSTANCE_MISMATCH",
      "A join requires an instance prefix.",
    );
  const join = await readJson(joinFile(sys));
  if (!join) return null;
  checkIdentity(join, sys.paths.instanceUser);
  if (
    typeof join.requestId !== "string" ||
    !REQUEST_ID.test(join.requestId) ||
    typeof join.nonceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(join.nonceHash) ||
    !Number.isFinite(Date.parse(join.expiresAt)) ||
    (join.claimStartedAt !== undefined &&
      !Number.isFinite(Date.parse(join.claimStartedAt)))
  )
    throw new BootstrapError(
      409,
      "INSTANCE_MISMATCH",
      "The join reservation is invalid.",
    );
  return join;
}

async function requireReservation(sys) {
  const join = await readReservation(sys);
  if (!join)
    throw new BootstrapError(
      409,
      "JOIN_NOT_FOUND",
      "The instance has no join reservation.",
    );
  return join;
}

async function removeReservation(sys, { removeInstall = false } = {}) {
  const unitFile = path.join(sys.paths.systemdDir, sys.paths.joinUnitName);
  const unitExists = await fs.stat(unitFile).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (unitExists)
    await sys.run("systemctl", ["disable", sys.paths.joinUnitName]);
  await fs.rm(unitFile, { force: true });
  await removeJoinFiles(sys);
  if (unitExists) {
    await sys.run("systemctl", ["daemon-reload"]);
    // Do not wait for the expiring bootstrap's own process to exit.
    await sys.run("systemctl", ["stop", "--no-block", sys.paths.joinUnitName]);
  }
  if (removeInstall) {
    await fs.rm(sys.paths.installRoot, { recursive: true, force: true });
    await fs.rm(sys.paths.etcDir, { recursive: true, force: true });
  }
}

function isExpired(join, sys) {
  return (
    !join.claimStartedAt && Date.parse(join.expiresAt) <= sys.now().getTime()
  );
}

/** Expiry never interrupts a claim that has started, including a failed claim's retry. */
async function expireJoin(sys) {
  return sys.withHostLock(async () => {
    const claim = await readJson(claimFile(sys));
    if (claim) {
      checkIdentity(claim, sys.paths.instanceUser);
      return false;
    }
    const join = await readReservation(sys);
    if (!join || !isExpired(join, sys)) return false;
    await removeReservation(sys);
    return true;
  });
}

async function listenerPorts(sys) {
  let stdout;
  try {
    ({ stdout } = await sys.run("ss", ["-H", "-ltn"]));
  } catch {
    throw new BootstrapError(
      500,
      "PORT_CHECK_FAILED",
      "Cannot inspect the VM's listening ports.",
    );
  }
  const ports = new Set();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const port = line
      .trim()
      .split(/\s+/)[3]
      ?.match(/:(\d+)$/)?.[1];
    if (!port)
      throw new BootstrapError(
        500,
        "PORT_CHECK_FAILED",
        "Cannot inspect the VM's listening ports.",
      );
    ports.add(Number(port));
  }
  return ports;
}

function validateRequest(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.userName !== "string" ||
    !USER_NAME.test(body.userName) ||
    typeof body.requestId !== "string" ||
    !REQUEST_ID.test(body.requestId) ||
    !Number.isInteger(body.port) ||
    body.port < 1024 ||
    body.port > 65535
  )
    throw new BootstrapError(
      400,
      "INVALID_JOIN",
      "A join requires userName, homePath, port and requestId.",
    );
  validateHomePath(body.homePath);
}

async function checkAccount(request, sys) {
  const account = await sys.lookupUser(request.userName);
  if (
    account &&
    (account.home !== request.homePath ||
      account.uid < MIN_CLAIM_UID ||
      (account.uid < 1000 && account.uid !== request.uid))
  )
    throw new BootstrapError(
      409,
      "USER_EXISTS",
      `User ${request.userName} already exists with another home or as a system account.`,
    );
  if (
    !account &&
    (await fs.stat(request.homePath).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    ))
  )
    throw new BootstrapError(
      409,
      "HOME_EXISTS",
      `${request.homePath} already exists.`,
    );
}

async function reservationResult(join, sys) {
  let nonce;
  try {
    nonce = (await fs.readFile(nonceFile(sys), "utf8")).trim();
  } catch {
    throw new BootstrapError(
      409,
      "INSTANCE_MISMATCH",
      "The join secret is missing.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(nonce) || hashNonce(nonce) !== join.nonceHash)
    throw new BootstrapError(
      409,
      "INSTANCE_MISMATCH",
      "The join secret does not match its reservation.",
    );
  const { nonceHash, claimStartedAt, ...result } = join;
  return { ...result, nonce };
}

async function startJoin(join, sys) {
  await fs.mkdir(sys.paths.binDir, { recursive: true, mode: 0o755 });
  const unit = renderJoinUnit(join, sys.paths);
  const unitFile = path.join(sys.paths.systemdDir, sys.paths.joinUnitName);
  // A requestId retry renders the same unit; only a changed file needs a reload.
  const current = await fs.readFile(unitFile, "utf8").catch(() => null);
  if (current !== unit) {
    await writeAtomic(unitFile, unit, 0o644);
    await sys.run("systemctl", ["daemon-reload"]);
  }
  await sys.run("systemctl", ["enable", "--now", sys.paths.joinUnitName]);
}

/** Reserves and starts a nonce-bound HTTPS bootstrap; requestId retries retain its identity. */
async function reserveJoin(request, sys) {
  validateRequest(request);
  return sys.withHostLock(async () => {
    await assertJoinAllowed(sys);
    const registry = await readRegistry(sys);
    if (!registry.some((entry) => entry.claim && !entry.sys))
      throw new BootstrapError(409, "NOT_CLAIMED", "This VM is not claimed.");
    const live = [];
    for (const entry of registry) {
      if (entry.join && isExpired(entry.join, sys))
        await removeReservation(entry.sys);
      else live.push(entry);
    }
    const existing = live.find(
      (entry) => (entry.claim ?? entry.join).userName === request.userName,
    );
    const own = createInstanceSystem(sys, request.userName);
    if (existing?.join && existing.join.requestId === request.requestId) {
      if (existing.join.homePath !== request.homePath)
        throw new BootstrapError(
          409,
          "USER_EXISTS",
          `User ${request.userName} already exists with another home.`,
        );
      const result = await reservationResult(existing.join, own);
      await startJoin(existing.join, own);
      return result;
    }
    if (existing) throw instanceExists(existing.claim ?? existing.join);
    await checkAccount(request, sys);
    const used = await listenerPorts(sys);
    for (const entry of live) used.add((entry.claim ?? entry.join).port);
    let port = request.port;
    if (used.has(port)) {
      port = Array.from({ length: 1000 }, (_, index) => 3000 + index).find(
        (candidate) => !used.has(candidate),
      );
    }
    if (port === undefined)
      throw new BootstrapError(
        409,
        "NO_INSTANCE_PORT",
        "No free DevChain port remains in 3000-3999.",
      );
    const nonce = randomBytes(32).toString("hex");
    const join = {
      userName: request.userName,
      homePath: request.homePath,
      port,
      requestId: request.requestId,
      nonceHash: hashNonce(nonce),
      expiresAt: new Date(sys.now().getTime() + JOIN_TTL_MS).toISOString(),
    };
    await fs.mkdir(own.paths.etcDir, { recursive: true, mode: 0o755 });
    await writeAtomic(nonceFile(own), `${nonce}\n`);
    await writeAtomic(joinFile(own), `${JSON.stringify(join, null, 2)}\n`);
    await startJoin(join, own);
    return {
      userName: join.userName,
      homePath: join.homePath,
      port,
      requestId: join.requestId,
      expiresAt: join.expiresAt,
      nonce,
    };
  });
}

function validateBinding(claim, join) {
  if (
    claim.userName !== join.userName ||
    claim.homePath !== join.homePath ||
    claim.port !== join.port
  )
    throw new BootstrapError(
      403,
      "JOIN_BINDING_MISMATCH",
      "The claim must use the reserved user, home and port.",
    );
  const hash = createHash("sha256")
    .update(typeof claim.nonce === "string" ? claim.nonce : "")
    .digest();
  const expected = Buffer.from(join.nonceHash, "hex");
  if (expected.length !== hash.length || !timingSafeEqual(hash, expected))
    throw new BootstrapError(
      403,
      "INVALID_JOIN_NONCE",
      "The join nonce is invalid.",
    );
}

async function beginJoinClaim(claim, sys) {
  return sys.withHostLock(async () => {
    await assertJoinAllowed(sys);
    const ownClaim = await readJson(claimFile(sys));
    if (ownClaim)
      throw instanceExists(checkIdentity(ownClaim, sys.paths.instanceUser));
    const join = await requireReservation(sys);
    validateBinding(claim, join);
    if (isExpired(join, sys)) {
      await removeReservation(sys);
      throw new BootstrapError(
        409,
        "JOIN_EXPIRED",
        "The join reservation has expired.",
      );
    }
    if (!join.claimStartedAt)
      await writeAtomic(
        joinFile(sys),
        `${JSON.stringify({ ...join, claimStartedAt: sys.now().toISOString() }, null, 2)}\n`,
      );
  });
}

/** Called under the host lock after the claim record has been written. */
async function completeJoin(sys) {
  await removeJoinFiles(sys);
}

async function cancelJoin({ userName, requestId }, sys) {
  if (
    typeof userName !== "string" ||
    !USER_NAME.test(userName) ||
    typeof requestId !== "string"
  )
    throw new BootstrapError(
      400,
      "INVALID_JOIN",
      "A cancellation requires userName and requestId.",
    );
  const own = createInstanceSystem(sys, userName);
  return sys.withHostLock(async () => {
    const claim = await readJson(claimFile(own));
    if (claim) throw instanceExists(checkIdentity(claim, userName));
    const join = await readReservation(own);
    if (!join) return { cancelled: true };
    if (join.requestId !== requestId) throw instanceExists(join);
    if (join.claimStartedAt)
      throw new BootstrapError(
        409,
        "CLAIM_STARTED",
        "A join claim has already started.",
      );
    await removeReservation(own, { removeInstall: true });
    return { cancelled: true };
  });
}

module.exports = {
  JOIN_TTL_MS,
  readRegistry,
  readReservation,
  requireReservation,
  reserveJoin,
  cancelJoin,
  expireJoin,
  beginJoinClaim,
  completeJoin,
  instanceExists,
  validateBinding,
};
