#!/usr/bin/env node
"use strict";

// Root helper behind DevChain's POST /api/host/update (run through sudo).
//   devchain-host-update <version> [--registry <url>]        start the update in its own unit and return
//   devchain-host-update --run <version> [--registry <url>]  the update itself (run by that unit)
// --registry (http or https) is where DevChain installs from; the default is the manifest's registry.
// Cross-version contract: --clis <version> requires runtime packages; agent tools may be skipped.
// It then installs CLIs and re-writes the instance service when a claim record exists.
// stdout is exactly one JSON line {cliVersions:{...},skippedTools:[...]}; failures use stderr
// {code,message} and the existing exit codes. Older helpers invoke this mode.
const { createInstalledSystem } = require("../lib/system");
const { requireHelperInstance } = require("../lib/helper-instance");
const { requestDocker, runDocker } = require("../lib/docker");
const { requestUpdate, runUpdate } = require("../lib/update");
const { installClis } = require("../lib/clis");
const { installPrivilegedSyncthing } = require("../lib/syncthing");
const { ensureBasePackages } = require("../lib/packages");
const { destroyFence } = require("../lib/fence");
const {
  refreshHostUnit,
  ensureIdsProfile,
  ensureInstanceProfile,
} = require("../lib/claim");
const { isSemver, BootstrapError } = require("../lib/validate");

/** The `--registry <url>` pair after the version, or undefined when absent. */
function registryArg(rest) {
  if (rest.length === 0) return undefined;
  if (rest.length !== 2 || rest[0] !== "--registry")
    throw new BootstrapError(
      400,
      "INVALID_ARGUMENT",
      "Use <version> [--registry <url>] or --run <version> [--registry <url>].",
    );
  return rest[1];
}

async function main(argv) {
  if (process.getuid() !== 0)
    throw Object.assign(new Error("Run as root."), { exitCode: 77 });
  const sys = createInstalledSystem();
  await requireHelperInstance(sys, {
    allowClaiming: argv[0] === "--clis",
    sudoUser: process.env.SUDO_USER ?? null,
  });
  if (argv[0] === "--fence") {
    if (argv.length !== 3)
      throw new BootstrapError(
        400,
        "INVALID_ARGUMENT",
        "Use --fence set|clear <operationId>.",
      );
    return destroyFence(argv[1], argv[2], sys);
  }
  if (argv[0] === "--docker") {
    if (argv[1] === "--run") await runDocker(sys, argv[2]);
    else if (argv.length === 1) return requestDocker(sys);
    else
      throw new BootstrapError(
        400,
        "INVALID_ARGUMENT",
        "Use --docker or --docker --run.",
      );
    return { requested: "docker" };
  }
  if (argv[0] === "--clis") {
    if (!isSemver(argv[1]))
      throw new BootstrapError(
        400,
        "INVALID_VERSION",
        "version must be a semantic version.",
      );
    ensureIdsProfile(sys);
    ensureInstanceProfile(sys);
    const { skippedTools } = await ensureBasePackages(argv[1], sys);
    const cliVersions = await installClis(argv[1], sys);
    await installPrivilegedSyncthing(sys);
    if (await refreshHostUnit(sys))
      process.stderr.write(
        `${sys.paths.unitName} refreshed from this version's template.\n`,
      );
    return { cliVersions, skippedTools };
  }
  if (argv[0] === "--run") {
    await runUpdate(argv[1], sys, registryArg(argv.slice(2)));
    return { updated: argv[1] };
  }
  await requestUpdate(argv[0], sys, registryArg(argv.slice(1)));
  return { requested: argv[0] };
}

main(process.argv.slice(2)).then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stderr.write(
      `${JSON.stringify({ code: error.code ?? "UPDATE_FAILED", message: error.message })}\n`,
    );
    const byStatus = { 400: 2, 403: 4, 409: 3 };
    process.exit(error.exitCode ?? byStatus[error.status] ?? 1);
  },
);
