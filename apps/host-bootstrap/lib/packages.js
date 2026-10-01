"use strict";

const { readHostInstallPins } = require("./host-install-pins");

const LOCK_TIMEOUT_MS = 600_000;
const LOCK_RETRY_MS = 5_000;

// dpkg has no lock timeout, and apt's DPkg::Lock::Timeout does not cover the lists lock.
// Retry contention, never permission or database errors.
async function runWhenUnlocked(sys, lock, command, args, options) {
  const deadline = sys.now().getTime() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return await sys.run(command, args, options);
    } catch (error) {
      if (
        !/lock.*(?:locked by|held by|another process|temporarily unavailable|resource busy)/i.test(
          error.message,
        )
      )
        throw error;
      if (sys.now().getTime() + LOCK_RETRY_MS > deadline)
        throw new Error(
          `The ${lock} lock stayed busy for ${LOCK_TIMEOUT_MS / 1000} seconds. Wait for the other package manager to finish, then retry.`,
        );
      await sys.sleep(LOCK_RETRY_MS);
    }
  }
}

async function ensureBasePackages(version, sys) {
  try {
    const pins = readHostInstallPins(version, sys);
    if (
      !Array.isArray(pins?.aptPackages) ||
      pins.aptPackages.length === 0 ||
      pins.aptPackages.some(
        (name) =>
          typeof name !== "string" || !/^[a-z0-9][a-z0-9+.-]*$/.test(name),
      )
    )
      throw new Error(
        "aptPackages must be a nonempty list of valid Debian package names.",
      );
    const packages = [...new Set(pins.aptPackages)].filter(
      (name) => name !== "qemu-guest-agent",
    );
    const env = {
      ...process.env,
      DEBIAN_FRONTEND: "noninteractive",
      LC_ALL: "C",
    };
    const installed = await installedPackages(sys, { env });
    const missing = packages.filter((name) => !installed.has(name));
    if (!missing.length) return;
    const stepOptions = { env, timeoutMs: 10 * 60_000 };
    await runWhenUnlocked(
      sys,
      "dpkg",
      "dpkg",
      ["--configure", "-a"],
      stepOptions,
    );
    const aptOptions = ["-o", `DPkg::Lock::Timeout=${LOCK_TIMEOUT_MS / 1000}`];
    await runWhenUnlocked(
      sys,
      "apt lists",
      "apt-get",
      [...aptOptions, "update"],
      stepOptions,
    );
    await sys.run(
      "apt-get",
      [
        ...aptOptions,
        "install",
        "-y",
        "--no-install-recommends",
        "--no-remove",
        ...missing,
      ],
      { env, timeoutMs: 20 * 60_000 },
    );
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: "PACKAGES_FAILED" });
  }
}

/**
 * The names of every installed Debian package. Queries the whole database once,
 * because naming an unknown package makes dpkg-query fail.
 */
async function installedPackages(sys, options) {
  const { stdout } = await sys.run(
    "dpkg-query",
    ["-W", "-f=${Package} ${db:Status-Status}\\n"],
    options,
  );
  return new Set(
    stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([, status]) => status === "installed")
      .map(([name]) => name),
  );
}

module.exports = { ensureBasePackages, installedPackages, runWhenUnlocked };
