#!/usr/bin/env node
"use strict";

// Root helper behind DevChain's POST /api/host/update (run through sudo).
//   devchain-host-update <version>        start the update in its own unit and return
//   devchain-host-update --run <version>  the update itself (run by that unit)
// Cross-version contract: --clis <version> requires runtime packages; agent tools may be skipped.
// It then installs CLIs and re-writes devchain-host.service when a claim record exists.
// stdout is exactly one JSON line {cliVersions:{...},skippedTools:[...]}; failures use stderr
// {code,message} and the existing exit codes. Older helpers invoke this mode.
const { createSystem } = require("../lib/system");
const { requestDocker, runDocker } = require("../lib/docker");
const { requestUpdate, runUpdate } = require("../lib/update");
const { installClis } = require("../lib/clis");
const { ensureBasePackages } = require("../lib/packages");
const { refreshHostUnit, ensureIdsProfile } = require("../lib/claim");
const { isSemver, BootstrapError } = require("../lib/validate");

async function main(argv) {
  if (process.getuid() !== 0)
    throw Object.assign(new Error("Run as root."), { exitCode: 77 });
  const sys = createSystem();
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
    const { skippedTools } = await ensureBasePackages(argv[1], sys);
    const cliVersions = await installClis(argv[1], sys);
    if (await refreshHostUnit(sys))
      process.stderr.write(
        "devchain-host.service refreshed from this version's template.\n",
      );
    return { cliVersions, skippedTools };
  }
  if (argv[0] === "--run") {
    await runUpdate(argv[1], sys);
    return { updated: argv[1] };
  }
  await requestUpdate(argv[0], sys);
  return { requested: argv[0] };
}

main(process.argv.slice(2)).then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stderr.write(
      `${JSON.stringify({ code: error.code ?? "UPDATE_FAILED", message: error.message })}\n`,
    );
    process.exit(
      error.exitCode ??
        (error.status === 409 ? 3 : error.status === 400 ? 2 : 1),
    );
  },
);
