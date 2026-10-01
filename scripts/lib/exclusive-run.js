const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { homedir, constants } = require("node:os");
const { join, resolve } = require("node:path");

const QUEUE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function isPid(value) {
  return Number.isInteger(value) && value > 0;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function readOwner(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isStale(owner) {
  // An unpublished pgid cannot prove that a crashed owner never spawned a child.
  return (
    owner &&
    isPid(owner.pid) &&
    isPid(owner.pgid) &&
    !isAlive(owner.pid) &&
    !isAlive(-owner.pgid)
  );
}

function removeReclaim(dir, file) {
  fs.rmSync(file, { force: true });
  try {
    fs.rmdirSync(dir);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function reclaim(dir, previousOwner) {
  const guard = `${dir}.reclaim`;
  const token = randomBytes(16).toString("hex");
  const guardFile = join(guard, `owner-${token}.json`);
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const files = fs.readdirSync(guard);
      if (files.length === 1 && /^owner-[a-f0-9]+\.json$/.test(files[0])) {
        const file = join(guard, files[0]);
        const owner = readOwner(file);
        if (
          owner &&
          isPid(owner.pid) &&
          Date.now() - Date.parse(owner.startedAt) > 60000 &&
          !isAlive(owner.pid)
        ) {
          // Token-specific unlink + nonrecursive rmdir cannot erase a new guard's owner.
          removeReclaim(guard, file);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return false;
  }

  try {
    const identity = fs.statSync(guard);
    fs.writeFileSync(
      guardFile,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    const current = fs.statSync(guard);
    if (identity.ino !== current.ino || identity.dev !== current.dev)
      return false;
    const owner = readOwner(join(dir, "owner.json"));
    if (owner && owner.token === previousOwner.token && isStale(owner)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally {
    removeReclaim(guard, guardFile);
  }
}

function signalState() {
  const state = { signal: null, pgid: null, wake: null };
  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      state.signal = state.signal || signal;
      if (state.pgid) {
        try {
          process.kill(-state.pgid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      if (state.wake) state.wake();
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  state.dispose = () =>
    handlers.forEach(([signal, handler]) =>
      process.removeListener(signal, handler),
    );
  return state;
}

function pause(ms, state) {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      state.wake = null;
      done();
    };
    const timer = setTimeout(finish, ms);
    state.wake = finish;
  });
}

function signalCode(signal) {
  return 128 + constants.signals[signal];
}

function formatWait(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function spawnAndForward(
  { command, args, env, pollMs, name },
  state,
  onSpawn,
) {
  if (state.signal) return signalCode(state.signal);
  const child = spawn(command, args, { env, stdio: "inherit", detached: true });
  state.pgid = child.pid || null;
  const result = new Promise((done) => {
    child.once("error", (error) => {
      process.stderr.write(
        `${name ? `Queue "${name}"` : "Command"} cannot start "${command}": ${error.message}\n`,
      );
      done(1);
    });
    child.once("exit", (code, signal) =>
      done(signal ? signalCode(signal) : code),
    );
  });
  let publishError;
  try {
    if (state.pgid && onSpawn) onSpawn(state.pgid);
  } catch (error) {
    publishError = error;
    process.kill(-state.pgid, "SIGTERM");
  }
  const code = await result;
  // The launcher may exit before its descendants; group liveness owns the lock.
  while (state.pgid && isAlive(-state.pgid)) await pause(pollMs, state);
  state.pgid = null;
  if (publishError) throw publishError;
  return state.signal ? signalCode(state.signal) : code;
}

async function runCommand({
  command,
  args = [],
  env = process.env,
  pollMs = 2000,
}) {
  const state = signalState();
  try {
    return await spawnAndForward({ command, args, env, pollMs }, state);
  } finally {
    state.dispose();
  }
}

async function runExclusive({
  name,
  command,
  args = [],
  env = process.env,
  lockRoot,
  pollMs = 2000,
}) {
  if (!QUEUE_NAME.test(name))
    throw new Error(`Queue name must match ${QUEUE_NAME.source}.`);
  if (!Number.isFinite(pollMs) || pollMs <= 0)
    throw new Error("Queue pollMs must be positive.");
  const root = resolve(
    lockRoot || env.DEVCHAIN_QUEUE_DIR || join(homedir(), ".devchain", "locks"),
  );
  const dir = join(root, name);
  const file = join(dir, "owner.json");
  const markers = (env.DEVCHAIN_QUEUE_HELD || "").split(",").filter(Boolean);
  const inherited = markers.some((entry) => entry.startsWith(`${name}@`))
    ? readOwner(file)
    : null;
  if (
    inherited &&
    markers.includes(`${name}@${inherited.token}`) &&
    isPid(inherited.pid) &&
    isAlive(inherited.pid)
  ) {
    return runCommand({ command, args, env, pollMs });
  }

  const state = signalState();
  const owner = {
    pid: process.pid,
    pgid: null,
    token: randomBytes(16).toString("hex"),
    name,
    command: [command, ...args]
      .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
      .join(" "),
    cwd: process.cwd(),
    startedAt: null,
  };
  let acquired = false;
  let waitStart = null;
  let lastNotice = null;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    while (!state.signal) {
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
        acquired = true;
        owner.startedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const holder = readOwner(file);
      if (isStale(holder) && reclaim(dir, holder)) continue;
      const now = Date.now();
      waitStart ??= now;
      if (lastNotice === null || now - lastNotice >= 60000) {
        const waited =
          now > waitStart ? ` Waited ${formatWait(now - waitStart)}.` : "";
        process.stderr.write(
          `Queue "${name}" waiting for pid ${holder?.pid ?? "unknown"}: ${holder?.command ?? "unknown command"} (started ${holder?.startedAt ?? "unknown"}).${waited}\n`,
        );
        lastNotice = now;
      }
      await pause(pollMs, state);
    }
    if (state.signal) return signalCode(state.signal);
    const waited = waitStart === null ? null : Date.now() - waitStart;
    const childEnv = {
      ...env,
      DEVCHAIN_QUEUE_DIR: root,
      DEVCHAIN_QUEUE_HELD: [
        ...markers.filter((entry) => !entry.startsWith(`${name}@`)),
        `${name}@${owner.token}`,
      ].join(","),
    };
    const code = await spawnAndForward(
      { name, command, args, env: childEnv, pollMs },
      state,
      (pgid) => {
        owner.pgid = pgid;
        const tempFile = join(dir, `owner-${owner.token}.tmp`);
        fs.writeFileSync(tempFile, JSON.stringify(owner), { mode: 0o600 });
        fs.renameSync(tempFile, file);
      },
    );
    // The last line reaches a caller that only reads the tail of its log.
    if (waited !== null)
      process.stderr.write(
        `Queue "${name}" waited ${formatWait(waited)} before this run.\n`,
      );
    return code;
  } finally {
    if (acquired) {
      const current = readOwner(file);
      if (!current || current.token === owner.token)
        fs.rmSync(dir, { recursive: true, force: true });
    }
    state.dispose();
  }
}

module.exports = { QUEUE_NAME, runExclusive, runCommand };
