"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { requestUpdate, runUpdate, readStatus } = require("../lib/update");
const { readClaim, activateVersion } = require("../lib/claim");
const {
  fakeSystem,
  pins,
  pinnedCliVersions,
  manifestOnlyDevchainCatalog,
  assertProviderClisInstalledFromPublicRegistry,
} = require("./helpers");

function claimed(sys) {
  fs.mkdirSync(sys.paths.etcDir, { recursive: true });
  const prefix = path.join(sys.paths.installRoot, "versions/0.24.0/bin");
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(path.join(prefix, "devchain"), "0.24.0");
  activateVersion("0.24.0", sys);
  const record = {
    userName: "alice",
    homePath: "/Users/alice",
    version: "0.24.0",
    port: 3000,
    claimedAt: "then",
  };
  fs.writeFileSync(
    path.join(sys.paths.etcDir, "claim.json"),
    JSON.stringify(record),
  );
}

test("an update request starts the update outside the DevChain service and returns", async (t) => {
  const { sys, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  claimed(sys);
  await requestUpdate("0.25.0", sys);
  assert.deepEqual(calls, [
    [
      "systemd-run",
      "--unit=devchain-host-update",
      "--collect",
      "--no-block",
      "--quiet",
      path.join(sys.paths.binDir, "devchain-host-update"),
      "--run",
      "0.25.0",
    ],
  ]);
  assert.equal(readStatus(sys).state, "pending");
});

test("the update waits longer than the host stop timeout and records done", async (t) => {
  const { sys, calls, callDetails, cleanup } = fakeSystem();
  t.after(cleanup);
  claimed(sys);
  await runUpdate("0.25.0", sys);
  assert.deepEqual(
    calls.filter(([command]) => command === "npm").map((call) => call.at(-1)),
    [
      "devchain-cli@0.25.0",
      path.join(
        sys.paths.installRoot,
        "versions/0.25.0/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz",
      ),
      `@anthropic-ai/claude-code@${pins.claude.version}`,
      `@openai/codex@${pins.codex.version}`,
      `@github/copilot@${pins.copilot.version}`,
      `opencode-ai@${pins.opencode.version}`,
    ],
  );
  assert.ok(
    calls.findIndex(([command]) => command === "bash") <
      calls.findIndex(([command]) => command === "systemctl"),
  );
  const restart = callDetails.find(
    ({ command, args }) =>
      command === "systemctl" &&
      args[0] === "restart" &&
      args[1] === "devchain-host.service",
  );
  assert.ok(restart, "the host service is restarted");
  const unit = fs.readFileSync(
    path.join(__dirname, "../systemd/devchain-host.service"),
    "utf8",
  );
  const stopTimeout = unit.match(/^TimeoutStopSec=(\d+)$/m);
  assert.ok(stopTimeout, "the host unit sets TimeoutStopSec");
  assert.ok(
    restart.options.timeoutMs > Number(stopTimeout[1]) * 1000,
    "the command timeout exceeds the host unit stop timeout",
  );
  assert.equal(
    fs.readFileSync(path.join(sys.paths.binDir, "devchain"), "utf8"),
    "0.25.0",
  );
  assert.deepEqual(
    fs.readdirSync(path.join(sys.paths.installRoot, "versions")),
    ["0.25.0"],
  );
  assert.equal(readClaim(sys).version, "0.25.0");
  assert.deepEqual(readClaim(sys).cliVersions, pinnedCliVersions());
  assert.equal(readClaim(sys).claimedAt, "then");
  assert.deepEqual(
    { ...readStatus(sys), at: undefined },
    { state: "done", version: "0.25.0", at: undefined },
  );
});

test("an update installs changed pins before activating the new version", async (t) => {
  const nextPins = { ...pins, codex: { ...pins.codex, version: "0.157.0" } };
  const { sys, calls, cleanup } = fakeSystem({
    pinsByVersion: { "0.25.0": nextPins },
  });
  t.after(cleanup);
  claimed(sys);
  for (const name of ["claude", "codex", "copilot", "opencode"]) {
    const file = path.join(
      sys.paths.cliPrefix,
      "lib/node_modules",
      pins[name].package,
      "package.json",
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: pins[name].version }));
    fs.writeFileSync(path.join(sys.paths.binDir, name), pins[name].version);
  }
  fs.writeFileSync(path.join(sys.paths.binDir, "agy"), "1.0.0");
  const run = sys.run;
  sys.run = async (command, args, options) => {
    if (command === "npm" && args.at(-1)?.startsWith("@openai/codex@")) {
      assert.equal(
        fs.readFileSync(path.join(sys.paths.binDir, "devchain"), "utf8"),
        "0.24.0",
      );
    }
    return run(command, args, options);
  };
  await runUpdate("0.25.0", sys);
  assert.deepEqual(
    calls.filter(([command]) => command === "npm").map((call) => call.at(-1)),
    [
      "devchain-cli@0.25.0",
      path.join(
        sys.paths.installRoot,
        "versions/0.25.0/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz",
      ),
      "@openai/codex@0.157.0",
    ],
  );
  assert.equal(readClaim(sys).cliVersions.codex, "0.157.0");
});

test("an update succeeds when the manifest registry serves only devchain-cli", async (t) => {
  const { sys, callDetails, cleanup } = fakeSystem({
    registryCatalog: manifestOnlyDevchainCatalog,
  });
  t.after(cleanup);
  claimed(sys);
  await runUpdate("0.25.0", sys);
  assert.equal(readClaim(sys).version, "0.25.0");
  assert.deepEqual(readClaim(sys).cliVersions, pinnedCliVersions());
  assertProviderClisInstalledFromPublicRegistry(callDetails);
});

test("a failed install records the failure and keeps the claimed version", async (t) => {
  const { sys, calls, cleanup } = fakeSystem({
    failOn: (command) => command === "npm",
  });
  t.after(cleanup);
  claimed(sys);
  await assert.rejects(runUpdate("0.25.0", sys));
  assert.equal(readStatus(sys).state, "failed");
  assert.equal(readClaim(sys).version, "0.24.0");
  assert.equal(
    fs.readFileSync(path.join(sys.paths.binDir, "devchain"), "utf8"),
    "0.24.0",
  );
  assert.ok(!calls.some(([command]) => command === "systemctl"));
});

test("an update without CLI pins fails before switching versions", async (t) => {
  const { sys, cleanup } = fakeSystem({ missingPins: true });
  t.after(cleanup);
  claimed(sys);
  await assert.rejects(
    runUpdate("0.25.0", sys),
    /missing dist\/host-cli-pins\.json/,
  );
  assert.match(readStatus(sys).error, /missing dist\/host-cli-pins\.json/);
  assert.equal(readClaim(sys).version, "0.24.0");
  assert.equal(
    fs.readFileSync(path.join(sys.paths.binDir, "devchain"), "utf8"),
    "0.24.0",
  );
});

test("an update to the running version changes nothing", async (t) => {
  const { sys, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  claimed(sys);
  await runUpdate("0.24.0", sys);
  assert.deepEqual(calls, []);
  assert.equal(
    fs.readFileSync(path.join(sys.paths.binDir, "devchain"), "utf8"),
    "0.24.0",
  );
  assert.equal(readStatus(sys).state, "done");
});

test("updates are refused before a claim and for a non-semver version", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  await assert.rejects(requestUpdate("0.25.0", sys), { code: "NOT_CLAIMED" });
  claimed(sys);
  await assert.rejects(requestUpdate("latest", sys), {
    code: "INVALID_VERSION",
  });
});

test("update refreshes while installing and records the new helper's CLI result", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  claimed(sys);
  const run = sys.run;
  let refreshed = false;
  sys.run = async (command, args, options) => {
    if (command === "npm" && args.at(-1).endsWith(".tgz")) {
      assert.equal(readStatus(sys).state, "installing");
      refreshed = true;
    }
    if (args[0] === "--clis") {
      assert.equal(refreshed, true);
      assert.equal(readStatus(sys).state, "installing_clis");
      assert.equal(options.timeoutMs, 45 * 60_000);
      return {
        stdout: '{"cliVersions":{"future-cli":"5.0.0","agy":"agy 2.0.0"}}\n',
      };
    }
    return run(command, args, options);
  };
  await runUpdate("0.25.0", sys);
  assert.deepEqual(readClaim(sys).cliVersions, {
    "future-cli": "5.0.0",
    agy: "agy 2.0.0",
  });
});

for (const failure of ["hash", "child", "packages"]) {
  test(`update preserves activation and records ${failure} failure`, async (t) => {
    const { sys, cleanup } = fakeSystem();
    t.after(cleanup);
    claimed(sys);
    const run = sys.run;
    sys.run = async (command, args, options) => {
      if (failure === "child" && args[0] === "--clis")
        throw new Error("helper stderr: new CLI download failed");
      if (failure === "packages" && args[0] === "--clis")
        throw new Error(
          'helper stderr: {"code":"PACKAGES_FAILED","message":"apt-get install failed"}',
        );
      const result = await run(command, args, options);
      if (failure === "hash" && command.endsWith("/devchain")) {
        fs.writeFileSync(
          path.join(
            sys.paths.installRoot,
            "versions/0.25.0/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz",
          ),
          "damaged",
        );
      }
      return result;
    };
    await assert.rejects(runUpdate("0.25.0", sys));
    assert.match(
      readStatus(sys).error,
      failure === "hash"
        ? /SHA-256 mismatch/
        : failure === "packages"
          ? /PACKAGES_FAILED.*apt-get install failed/
          : /new CLI download failed/,
    );
    assert.equal(readStatus(sys).state, "failed");
    assert.equal(readClaim(sys).version, "0.24.0");
    assert.equal(
      fs.readFileSync(path.join(sys.paths.binDir, "devchain"), "utf8"),
      "0.24.0",
    );
  });
}
