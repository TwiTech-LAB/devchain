"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { createInstanceSystem } = require("../lib/system");
const { fakeSystem } = require("./helpers");

// Run the CLI parser with fake OS commands to verify stdin and stdout without root.
async function execute(argv, input, sys, { userName = "bob", uid = 0 } = {}) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let started;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const installed = createInstanceSystem(sys, userName);
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../bin/devchain-bootstrap.js"),
      "utf8",
    ),
    {
      Buffer,
      require: (name) => {
        if (name === "../lib/system")
          return {
            createSystem: () => sys,
            createInstalledSystem: () => installed,
          };
        if (name === "../lib/server")
          return {
            main: async (options) => {
              started = options.sys;
              finish();
            },
          };
        return require(name);
      },
      process: {
        argv: ["node", "devchain-bootstrap", ...argv],
        getuid: () => uid,
        stdin: Readable.from([
          typeof input === "string" ? input : JSON.stringify(input),
        ]),
        stdout: {
          write: (value) => {
            stdout += value;
            finish();
          },
        },
        stderr: {
          write: (value) => {
            stderr += value;
          },
        },
        set exitCode(value) {
          exitCode = value;
          finish();
        },
      },
    },
  );
  await completed;
  return { stdout, stderr, exitCode, started };
}

function claimed(t) {
  const fake = fakeSystem();
  t.after(fake.cleanup);
  fs.writeFileSync(
    path.join(fake.sys.paths.etcDir, "claim.json"),
    JSON.stringify({ userName: "alice", homePath: "/Users/alice", port: 3000 }),
  );
  return fake;
}

const request = {
  userName: "bob",
  homePath: "/Users/bob",
  port: 3000,
  requestId: "bob-request",
};

test("reserve, resume, serve and cancel commands use the same stdin reservation contract", async (t) => {
  const { sys } = claimed(t);
  const first = await execute(["--reserve-join"], request, sys);
  assert.equal(first.exitCode, 0);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout.trim().split("\n").length, 1);
  const reservation = JSON.parse(first.stdout);
  assert.equal(reservation.port, 3001);
  assert.equal(reservation.requestId, request.requestId);
  assert.match(reservation.nonce, /^[a-f0-9]{64}$/);
  const retry = await execute(["--reserve-join"], request, sys);
  assert.deepEqual(JSON.parse(retry.stdout), reservation);
  const serving = await execute(["--join", "bob"], "", sys);
  assert.equal(serving.started.paths.unitName, "devchain-user-bob.service");
  const cancel = await execute(["--cancel-join"], request, sys);
  assert.deepEqual(JSON.parse(cancel.stdout), { cancelled: true });
});

test("join CLI refuses non-root, malformed stdin, oversized stdin and mismatched helper identity", async (t) => {
  const { sys } = claimed(t);
  for (const [argv, input, options, expectedCode, expectedExit] of [
    [["--reserve-join"], request, { uid: 1001 }, "BOOTSTRAP_FAILED", 77],
    [["--reserve-join"], "secret-not-json", {}, "INVALID_JOIN", 2],
    [["--reserve-join"], "secret".repeat(3000), {}, "INVALID_JOIN", 2],
    [
      ["--reserve-join"],
      { ...request, userName: "carol" },
      {},
      "INSTANCE_MISMATCH",
      3,
    ],
    [["--join", "carol"], "", {}, "INSTANCE_MISMATCH", 3],
  ]) {
    const result = await execute(argv, input, sys, options);
    assert.equal(result.stdout, "");
    assert.equal(result.exitCode, expectedExit);
    assert.equal(JSON.parse(result.stderr).code, expectedCode);
    assert.equal(result.stderr.includes("secret"), false);
  }
});
