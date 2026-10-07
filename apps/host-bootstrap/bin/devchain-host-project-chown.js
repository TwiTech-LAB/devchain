#!/usr/bin/env node
"use strict";
const { createSystem } = require("../lib/system");
const { repairProjectOwner } = require("../lib/project-chown");

async function main(argv) {
  if (process.getuid() !== 0)
    throw Object.assign(new Error("Run as root."), { exitCode: 77 });
  if (argv.length !== 3)
    throw Object.assign(new Error("Expected root, mode and path."), {
      exitCode: 2,
    });
  return repairProjectOwner(argv[0], argv[1], argv[2], createSystem());
}
main(process.argv.slice(2)).then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stderr.write(
      `${JSON.stringify({ code: error.code ?? "CHOWN_FAILED", message: error.message, changed: error.changed ?? [] })}\n`,
    );
    process.exit(
      error.exitCode ?? { 400: 2, 403: 4, 409: 3 }[error.status] ?? 1,
    );
  },
);
