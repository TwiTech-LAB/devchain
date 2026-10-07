"use strict";

const { readHostInstallPins } = require("./host-install-pins");

const LOCK_TIMEOUT_MS = 600_000;
const LOCK_RETRY_MS = 5_000;
const TOOLS_TIMEOUT_MS = 10 * 60_000;
const TOOL_GROUP_TIMEOUT_MS = 3 * 60_000;
const TOOL_TIMEOUT_MS = 2 * 60_000;
// The states a failed tool attempt may leave; any other state makes apt refuse later installs.
const SETTLED_STATUSES = new Set([
  "installed",
  "not-installed",
  "config-files",
]);
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*$/;
const isPackageName = (name) =>
  typeof name === "string" && PACKAGE_NAME.test(name);
// An apt dry run marks a change to an installed package as "Inst <name> [<installed version>]".
const CHANGES_INSTALLED = /^Inst (\S+) \[/;
const APT_OPTIONS = ["-o", `DPkg::Lock::Timeout=${LOCK_TIMEOUT_MS / 1000}`];
const INSTALL_OPTIONS = [
  ...APT_OPTIONS,
  "install",
  "-y",
  "--no-install-recommends",
  "--no-remove",
];

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
  let pins;
  let installed;
  let env;
  let prepared = false;
  try {
    pins = readHostInstallPins(version, sys);
    if (
      !Array.isArray(pins?.aptPackages) ||
      pins.aptPackages.length === 0 ||
      !pins.aptPackages.every(isPackageName)
    )
      throw new Error(
        "aptPackages must be a nonempty list of valid Debian package names.",
      );
    const packages = [...new Set(pins.aptPackages)].filter(
      (name) => name !== "qemu-guest-agent",
    );
    env = {
      ...process.env,
      DEBIAN_FRONTEND: "noninteractive",
      LC_ALL: "C",
    };
    installed = await installedPackages(sys, { env });
    const missing = packages.filter((name) => !installed.has(name));
    if (missing.length) {
      const stepOptions = { env, timeoutMs: 10 * 60_000 };
      await runWhenUnlocked(
        sys,
        "dpkg",
        "dpkg",
        ["--configure", "-a"],
        stepOptions,
      );
      try {
        await runWhenUnlocked(
          sys,
          "apt lists",
          "apt-get",
          [...APT_OPTIONS, "update"],
          stepOptions,
        );
      } catch (error) {
        process.stderr.write(`apt-get update failed: ${error.message}\n`);
      }
      await sys.run("apt-get", [...INSTALL_OPTIONS, ...missing], {
        env,
        timeoutMs: 20 * 60_000,
      });
      prepared = true;
    }
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: "PACKAGES_FAILED" });
  }
  return {
    skippedTools: await ensureToolPackages(
      pins.toolPackages,
      installed,
      sys,
      env,
      prepared,
    ),
  };
}

async function ensureToolPackages(packages, installed, sys, env, prepared) {
  if (packages === undefined) return [];
  if (!Array.isArray(packages)) {
    process.stderr.write(
      "Skipping agent tools: toolPackages must be an array.\n",
    );
    return [];
  }
  const missing = [...new Set(packages)].filter((name) => !installed.has(name));
  if (!missing.length) return [];
  const skipped = new Set(missing);
  const valid = missing.filter(isPackageName);

  // Preparation, apt's own lock waits and every retry share this deadline.
  const deadline = sys.now().getTime() + TOOLS_TIMEOUT_MS;
  const run = async (command, args, timeoutMs) => {
    const remaining = deadline - sys.now().getTime();
    if (remaining <= 0) throw new Error("Agent tools time budget exhausted.");
    return sys.run(command, args, {
      env,
      timeoutMs: Math.min(timeoutMs, remaining),
    });
  };
  try {
    if (valid.length) {
      if (!prepared) {
        await run("dpkg", ["--configure", "-a"], TOOL_TIMEOUT_MS);
        try {
          await run("apt-get", [...APT_OPTIONS, "update"], TOOL_TIMEOUT_MS);
        } catch (error) {
          process.stderr.write(`apt-get update failed: ${error.message}\n`);
        }
      }
      // Cleanup never purges a package that was installed before the tools phase.
      const before = new Set(
        (
          await packageStates((command, args) =>
            run(command, args, TOOL_TIMEOUT_MS),
          )
        )
          .filter(([, status]) => status === "installed")
          .map(([name]) => name),
      );
      // Tools only add packages. A failed upgrade of a package that installed packages depend on
      // cannot be purged again, so a dry run skips an attempt that would change one.
      const install = async (names, timeoutMs) => {
        const { stdout } = await run(
          "apt-get",
          ["-s", ...INSTALL_OPTIONS, ...names],
          timeoutMs,
        );
        const changed = stdout
          .split("\n")
          .flatMap((line) => line.match(CHANGES_INSTALLED)?.[1] ?? []);
        if (changed.length)
          throw new Error(
            `it would change the installed packages ${changed.join(", ")}`,
          );
        try {
          await run("apt-get", [...INSTALL_OPTIONS, ...names], timeoutMs);
        } catch (error) {
          await cleanToolState(sys, env, before);
          throw error;
        }
      };
      try {
        await install(valid, TOOL_GROUP_TIMEOUT_MS);
        for (const name of valid) skipped.delete(name);
      } catch (error) {
        process.stderr.write(
          `Agent tools group install failed: ${error.message}\n`,
        );
        for (const name of valid) {
          if (sys.now().getTime() >= deadline) break;
          try {
            await install([name], TOOL_TIMEOUT_MS);
            skipped.delete(name);
          } catch (error) {
            process.stderr.write(
              `Skipping agent tool ${name}: ${error.message}\n`,
            );
          }
        }
      }
    }
  } catch (error) {
    process.stderr.write(`Agent tools phase failed: ${error.message}\n`);
  }
  const skippedTools = [...skipped];
  if (skippedTools.length)
    process.stderr.write(`Skipped agent tools: ${skippedTools.join(", ")}\n`);
  return skippedTools;
}

/**
 * A failed or killed tool install can leave a package unconfigured, and apt then refuses every
 * later install, including the next Update VM's requirements. Finishes the interrupted work,
 * then purges the packages that still do not configure and that the tools phase added. A package
 * from `before` stays, even when unsettled.
 */
async function cleanToolState(sys, env, before) {
  const run = (command, args) =>
    sys.run(command, args, { env, timeoutMs: TOOL_TIMEOUT_MS });
  try {
    await run("dpkg", ["--configure", "-a"]);
  } catch {
    // A package that fails to configure again is purged below.
  }
  try {
    const unsettled = (await packageStates(run))
      .filter(
        ([name, status]) => !SETTLED_STATUSES.has(status) && !before.has(name),
      )
      .map(([name]) => name);
    if (!unsettled.length) return;
    process.stderr.write(
      `Removing packages that failed to configure: ${unsettled.join(", ")}\n`,
    );
    await run("dpkg", ["--purge", "--force-remove-reinstreq", ...unsettled]);
  } catch (error) {
    process.stderr.write(`Agent tools cleanup failed: ${error.message}\n`);
  }
}

/** Every package dpkg knows, as [name with architecture when needed, status] pairs. */
async function packageStates(run) {
  const { stdout } = await run("dpkg-query", [
    "-W",
    "-f=${binary:Package} ${db:Status-Status}\\n",
  ]);
  return parseStates(stdout);
}

/** Parses `dpkg-query -W` lines of "<name> <status>" into [name, status] pairs. */
function parseStates(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, status]) => name && status);
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
    parseStates(stdout)
      .filter(([, status]) => status === "installed")
      .map(([name]) => name),
  );
}

module.exports = { ensureBasePackages, installedPackages, runWhenUnlocked };
