#!/usr/bin/env node
"use strict";

// Root helper behind DevChain's POST /api/host/projects/roots (run through sudo).
//   devchain-host-project-root <absolute-path>
const { createSystem } = require("../lib/system");
const { createProjectRoot } = require("../lib/project-root");

async function main(argv) {
  if (process.getuid() !== 0)
    throw Object.assign(new Error("Run as root."), { exitCode: 77 });
  return createProjectRoot(argv[0], createSystem());
}

main(process.argv.slice(2)).then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stderr.write(
      `${JSON.stringify({ code: error.code ?? "PROJECT_ROOT_FAILED", message: error.message })}\n`,
    );
    const byStatus = { 400: 2, 403: 4, 409: 3 };
    process.exit(error.exitCode ?? byStatus[error.status] ?? 1);
  },
);
