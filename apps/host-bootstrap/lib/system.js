"use strict";

const fs = require("node:fs");
const { execFile } = require("node:child_process");

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
  unitTemplate: require.resolve("../systemd/devchain-host.service"),
};

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
  return {
    paths: { ...DEFAULT_PATHS, ...overrides.paths },
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

module.exports = { createSystem, CommandError, parsePasswdLine };
