#!/usr/bin/env node
"use strict";

// devchain-bootstrap                         serve the unclaimed VM (HTTPS, port 3000)
// devchain-bootstrap --ensure-certificate    create the VM certificate if the VM is unclaimed and has none
if (process.argv[2] === "--ensure-certificate") {
  const { createSystem } = require("../lib/system");
  const { ensureCertificate } = require("../lib/tls");
  ensureCertificate(createSystem()).then(
    (result) =>
      process.stdout.write(
        `${JSON.stringify({ level: "info", msg: `VM certificate ${result}` })}\n`,
      ),
    (error) => {
      process.stderr.write(
        `${JSON.stringify({ level: "error", code: error.code ?? "TLS_UNAVAILABLE", msg: error.message })}\n`,
      );
      process.exit(1);
    },
  );
} else {
  const { main } = require("../lib/server");
  const { createSystem, createInstalledSystem } = require("../lib/system");
  const {
    reserveJoin,
    cancelJoin,
    requireReservation,
  } = require("../lib/instances");
  const { BootstrapError } = require("../lib/validate");
  async function run(argv) {
    if (argv.length === 0) return main();
    if (process.getuid() !== 0)
      throw Object.assign(new Error("Run as root."), { exitCode: 77 });
    if (argv[0] === "--join" && argv.length === 2) {
      const sys = createInstalledSystem();
      if (sys.paths.instanceUser !== argv[1])
        throw new BootstrapError(
          409,
          "INSTANCE_MISMATCH",
          "The join user does not match this helper.",
        );
      await requireReservation(sys);
      return main({ sys });
    }
    if (
      (argv[0] === "--reserve-join" || argv[0] === "--cancel-join") &&
      argv.length === 1
    ) {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 16 * 1024)
          throw new BootstrapError(
            400,
            "INVALID_JOIN",
            "The join request is too large.",
          );
      }
      let request;
      try {
        request = JSON.parse(input);
      } catch {
        throw new BootstrapError(
          400,
          "INVALID_JOIN",
          "The join request must be JSON.",
        );
      }
      if (!request || typeof request !== "object" || Array.isArray(request))
        throw new BootstrapError(
          400,
          "INVALID_JOIN",
          "The join request must be an object.",
        );
      const installed = createInstalledSystem();
      if (
        installed.paths.instanceUser &&
        request.userName !== installed.paths.instanceUser
      )
        throw new BootstrapError(
          409,
          "INSTANCE_MISMATCH",
          "The join user does not match this helper.",
        );
      const sys = createSystem();
      const result = await (argv[0] === "--reserve-join"
        ? reserveJoin(request, sys)
        : cancelJoin(request, sys));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    throw new BootstrapError(
      400,
      "INVALID_ARGUMENT",
      "Usage: devchain-bootstrap [--ensure-certificate | --reserve-join | --cancel-join | --join <user>]",
    );
  }
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ code: error.code ?? "BOOTSTRAP_FAILED", message: error.message })}\n`,
    );
    process.exitCode =
      error.exitCode ??
      (error.status === 409 ? 3 : error.status === 400 ? 2 : 1);
  });
}
