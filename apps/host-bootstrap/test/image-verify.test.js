"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Exercise the script's exact guest shell and CLI expression without booting a VM.
const script = fs.readFileSync(
  path.join(__dirname, "../../host-image/verify.sh"),
  "utf8",
);
const guestShell = script.match(/'path': '(\/bin\/[^']+)'/)[1];
const cliExpression = script.match(
  /if out=\$\(vm_exec ("[^\n]*?\$cli[^\n]+?)\) &&/,
)[1];
for (const [label, command, expected] of [
  ["success", "printf version", 0],
  ["missing command", "devchain_missing_verify_command", 127],
  ["nonzero command with output", "bash -c 'echo version; exit 42'", 42],
]) {
  test(`image CLI check preserves ${label} exit status`, () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `cli=$1; vm_exec() { "$2" -c "$1"; }; vm_exec ${cliExpression} "$2"`,
        "verify-smoke",
        command,
        guestShell,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, expected, result.stderr);
    assert.ok(result.stdout.length > 0);
  });
}

const readinessGate = script.match(
  /if out=\$\(vm_exec 'timeout 180 cloud-init status --wait'[\s\S]*?\nfi/,
)[0];
for (const status of [0, 1]) {
  test(`image assertions ${status === 0 ? "run after" : "stop on failed"} cloud-init readiness`, () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `vm_exec() { return ${status}; }; pass() { :; }; fail() { :; };\n${readinessGate}\nprintf boot-assertions`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, status);
    assert.equal(result.stdout.includes("boot-assertions"), status === 0);
  });
}

const bakedCertificateCheck = script.match(
  /# Read from the image itself[\s\S]*?\nfi/,
)[0];
for (const [label, answer, status, verdict] of [
  ["an image without /etc/devchain-host/tls", "false", 0, "PASS"],
  ["an image with /etc/devchain-host/tls", "true", 0, "FAIL"],
  [
    "an image guestfish cannot read",
    "guestfish: no operating system",
    1,
    "FAIL",
  ],
]) {
  test(`the baked-certificate check reports ${verdict} for ${label}`, () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `IMAGE=image.qcow2; FAILED=0
guestfish() {
  [ "$*" = '--ro --format=qcow2 -a image.qcow2 -i exists /etc/devchain-host/tls' ] || return 9
  echo '${answer}'; return ${status}
}
pass() { printf 'PASS  %s\\n' "$*"; }; fail() { printf 'FAIL  %s\\n' "$*"; FAILED=1; }
${bakedCertificateCheck}
exit "$FAILED"`,
      ],
      { encoding: "utf8" },
    );
    assert.match(result.stdout, new RegExp(`^${verdict} `), result.stderr);
    assert.equal(result.status, verdict === "PASS" ? 0 : 1);
  });
}
