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
} else if (process.argv.length > 2) {
  process.stderr.write("Usage: devchain-bootstrap [--ensure-certificate]\n");
  process.exit(2);
} else {
  require("../lib/server").main();
}
