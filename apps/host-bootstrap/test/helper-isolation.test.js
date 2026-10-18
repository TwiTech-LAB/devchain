"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const {
  createInstanceSystem,
  createInstalledSystem,
} = require("../lib/system");
const { requireHelperInstance } = require("../lib/helper-instance");
const {
  performClaim,
  readClaim,
  ensureInstanceProfile,
} = require("../lib/claim");
const { reserveJoin } = require("../lib/instances");
const { readStatus } = require("../lib/update");
const { readDockerStatus } = require("../lib/docker");
const { fakeSystem, pins, snapshot, mode } = require("./helpers");

// Real helper entrypoints and temporary files catch identity loss across hops;
// only OS commands are faked, so sibling mutations cannot be hidden by mocks.
async function execute(name, argv, base, own, { sudoUser, uid = 0 } = {}) {
  const file = path.join(__dirname, "../bin", `${name}.js`);
  const localRequire = createRequire(file);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    require: (moduleName) =>
      moduleName === "../lib/system"
        ? {
            createInstalledSystem: () =>
              createInstalledSystem(
                path.join(
                  own.paths.helperPrefix,
                  "lib/node_modules/devchain-host-bootstrap",
                ),
                base,
              ),
          }
        : localRequire(moduleName),
    process: {
      argv: ["node", name, ...argv],
      env: sudoUser ? { SUDO_USER: sudoUser } : {},
      getuid: () => uid,
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
      exit: (value) => {
        exitCode = value;
        finish();
      },
    },
  });
  await completed;
  return { stdout, stderr, exitCode };
}

async function twoInstances(t, options = {}) {
  const homeParent = /^\/(home|Users|var\/home)\//.test(os.homedir())
    ? os.homedir()
    : "/home";
  const fake = fakeSystem({ rootParent: homeParent, ...options });
  t.after(fake.cleanup);
  const { sys, root } = fake;
  const run = sys.run;
  sys.run = async (command, args, callOptions) => {
    if (command.endsWith("/devchain-host-update") && args[0] === "--clis") {
      const userName = path
        .relative(path.join(sys.paths.hostInstallRoot, "instances"), command)
        .split(path.sep)[0];
      const own =
        command === path.join(sys.paths.binDir, "devchain-host-update")
          ? sys
          : createInstanceSystem(sys, userName);
      fake.calls.push([command, ...args]);
      fake.callDetails.push({ command, args, options: callOptions });
      const result = await execute("devchain-host-update", args, sys, own);
      if (result.exitCode) throw new Error(result.stderr);
      return { stdout: result.stdout, stderr: result.stderr };
    }
    return run(command, args, callOptions);
  };
  await performClaim(
    {
      userName: "alice",
      homePath: path.join(root, "Users/alice"),
      version: "0.24.0",
      port: 3000,
      env: {},
      files: [],
    },
    sys,
    () => {},
  );
  const reservation = await reserveJoin(
    {
      userName: "bob",
      homePath: path.join(root, "Users/bob"),
      port: 3000,
      requestId: "join-bob",
    },
    sys,
  );
  const own = createInstanceSystem(sys, "bob");
  await performClaim(
    { ...reservation, version: "0.24.0", env: {}, files: [] },
    own,
    () => {},
  );
  return { ...fake, own };
}

function legacyFiles(sys) {
  return [
    path.join(sys.paths.etcDir, "claim.json"),
    path.join(sys.paths.systemdDir, sys.paths.unitName),
    path.join(sys.paths.sudoersDir, sys.paths.sudoersName),
    path.join(sys.paths.installRoot, "versions"),
    path.join(sys.paths.installRoot, "current"),
    path.join(sys.paths.installRoot, "bin"),
    sys.paths.binDir,
    sys.paths.helperPrefix,
  ];
}

test("B's update follows its own helper on every hop and preserves A; A's update preserves B", async (t) => {
  const nextPins = { ...pins, codex: { ...pins.codex, version: "0.157.0" } };
  const { sys, own, calls } = await twoInstances(t, {
    pinsByVersion: { "0.25.0": nextPins },
  });
  const beforeA = legacyFiles(sys).map(snapshot);
  const start = calls.length;
  const request = await execute(
    "devchain-host-update",
    ["0.25.0", "--registry", "https://r.example/"],
    sys,
    own,
    { sudoUser: "bob" },
  );
  assert.equal(request.exitCode, 0, request.stderr);
  assert.deepEqual(calls[start], [
    "systemd-run",
    "--unit=devchain-update-bob",
    "--collect",
    "--no-block",
    "--quiet",
    path.join(own.paths.binDir, "devchain-host-update"),
    "--run",
    "0.25.0",
    "--registry",
    "https://r.example/",
  ]);
  assert.equal(readStatus(own).state, "pending");
  const updated = await execute(
    "devchain-host-update",
    ["--run", "0.25.0", "--registry", "https://r.example/"],
    sys,
    own,
  );
  assert.equal(updated.exitCode, 0, updated.stderr);
  assert.ok(
    calls
      .slice(start)
      .find((call) => call[0] === "npm")
      .includes("--registry=https://r.example/"),
  );
  assert.equal(readClaim(own).version, "0.25.0");
  assert.equal(readClaim(own).cliVersions.codex, "0.157.0");
  assert.equal(
    fs.readFileSync(path.join(own.paths.binDir, "devchain"), "utf8"),
    "0.25.0",
  );
  assert.deepEqual(
    fs.readdirSync(path.join(own.paths.installRoot, "versions")),
    ["0.25.0"],
  );
  assert.equal(readStatus(own).state, "done");
  assert.equal(
    fs.existsSync(path.join(sys.paths.etcDir, "update.json")),
    false,
  );
  const ownCalls = calls.slice(start);
  assert.ok(
    ownCalls.some(
      (call) =>
        call[0] === path.join(own.paths.binDir, "devchain-host-update") &&
        call[1] === "--clis",
    ),
  );
  assert.deepEqual(
    ownCalls.filter((call) => call[0] === "systemctl" && call[1] === "restart"),
    [["systemctl", "restart", "devchain-user-bob.service"]],
  );
  assert.ok(
    ownCalls.some(
      (call) =>
        call[0] === "npm" &&
        call.at(-1).endsWith(".tgz") &&
        call.includes(`--prefix=${own.paths.helperPrefix}`),
    ),
  );
  assert.ok(
    ownCalls.some(
      (call) =>
        call[0] === "npm" &&
        call.at(-1).startsWith("@openai/codex@") &&
        call.includes(`--prefix=${own.paths.cliPrefix}`),
    ),
  );
  assert.deepEqual(legacyFiles(sys).map(snapshot), beforeA);
  const beforeB = [
    own.paths.installRoot,
    own.paths.etcDir,
    path.join(sys.paths.systemdDir, own.paths.unitName),
    path.join(sys.paths.sudoersDir, own.paths.sudoersName),
  ].map(snapshot);
  const legacyStart = calls.length;
  const legacyRequest = await execute(
    "devchain-host-update",
    ["0.25.0"],
    sys,
    sys,
    { sudoUser: "alice" },
  );
  assert.equal(legacyRequest.exitCode, 0, legacyRequest.stderr);
  assert.ok(calls[legacyStart].includes("--unit=devchain-host-update"));
  assert.equal(
    calls[legacyStart][5],
    path.join(sys.paths.binDir, "devchain-host-update"),
  );
  const legacyUpdated = await execute(
    "devchain-host-update",
    ["--run", "0.25.0"],
    sys,
    sys,
  );
  assert.equal(legacyUpdated.exitCode, 0, legacyUpdated.stderr);
  assert.equal(readClaim(sys).version, "0.25.0");
  assert.deepEqual(
    [
      own.paths.installRoot,
      own.paths.etcDir,
      path.join(sys.paths.systemdDir, own.paths.unitName),
      path.join(sys.paths.sudoersDir, own.paths.sudoersName),
    ].map(snapshot),
    beforeB,
  );
});

test("B's update to a pre-shared version keeps B's helper, so B's next Docker request stays B's", async (t) => {
  const { sys, own, calls } = await twoInstances(t, {
    preSharedVersions: ["0.23.0"],
  });
  const beforeA = legacyFiles(sys).map(snapshot);
  const beforeHelper = [own.paths.helperPrefix, own.paths.binDir].map(snapshot);
  const start = calls.length;
  const updated = await execute(
    "devchain-host-update",
    ["--run", "0.23.0"],
    sys,
    own,
  );
  assert.notEqual(updated.exitCode, 0);
  assert.match(updated.stderr, /does not support shared VMs/);
  assert.equal(readStatus(own).state, "failed");
  assert.equal(readClaim(own).version, "0.24.0");
  assert.ok(
    !calls
      .slice(start)
      .some((call) => call[0] === "npm" && call.at(-1).endsWith(".tgz")),
  );
  assert.deepEqual(
    [own.paths.helperPrefix, own.paths.binDir].map(snapshot),
    beforeHelper,
  );
  const dockerStart = calls.length;
  const request = await execute(
    "devchain-host-update",
    ["--docker"],
    sys,
    own,
    { sudoUser: "bob" },
  );
  assert.equal(request.exitCode, 0, request.stderr);
  assert.equal(calls[dockerStart][1], "--unit=devchain-docker-bob");
  assert.equal(
    calls[dockerStart][5],
    path.join(own.paths.binDir, "devchain-host-update"),
  );
  assert.deepEqual(legacyFiles(sys).map(snapshot), beforeA);
});

test("B's detached Docker worker uses B's job, group and service while keeping A's files", async (t) => {
  const { sys, own, calls } = await twoInstances(t);
  const before = legacyFiles(sys).map(snapshot);
  const run = sys.run;
  sys.run = async (command, args, options) =>
    command === "docker" ? { stdout: "29.0.0\n" } : run(command, args, options);
  const start = calls.length;
  const request = await execute(
    "devchain-host-update",
    ["--docker"],
    sys,
    own,
    { sudoUser: "bob" },
  );
  assert.equal(request.exitCode, 0, request.stderr);
  const { jobId } = JSON.parse(request.stdout);
  assert.deepEqual(calls[start], [
    "systemd-run",
    "--unit=devchain-docker-bob",
    "--collect",
    "--no-block",
    "--quiet",
    path.join(own.paths.binDir, "devchain-host-update"),
    "--docker",
    "--run",
    jobId,
  ]);
  const result = await execute(
    "devchain-host-update",
    ["--docker", "--run", jobId],
    sys,
    own,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(readDockerStatus(own).state, "done");
  assert.equal(readDockerStatus(own).jobId, jobId);
  assert.equal(readDockerStatus(sys), null);
  assert.deepEqual(
    calls.slice(start).filter((call) => call[0] === "usermod"),
    [["usermod", "-aG", "docker", "bob"]],
  );
  assert.deepEqual(
    calls
      .slice(start)
      .filter((call) => call[0] === "systemctl" && call[1] === "restart"),
    [["systemctl", "restart", "devchain-user-bob.service"]],
  );
  assert.ok(!calls.slice(start).some((call) => call[0] === "apt-get"));
  assert.deepEqual(legacyFiles(sys).map(snapshot), before);
});

test("B's project-root helper and an unregistered sudo admin still create B-owned roots", async (t) => {
  const { sys, own, owners, accounts } = await twoInstances(t);
  const bob = accounts.get("bob");
  for (const sudoUser of ["bob", "admin", undefined]) {
    const target = path.join(bob.home, `project-${sudoUser ?? "root"}`);
    const result = await execute(
      "devchain-host-project-root",
      [target],
      sys,
      own,
      { sudoUser },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      path: target,
      created: true,
    });
    assert.equal(owners.get(target), `${bob.uid}:${bob.gid}`);
  }
});

test("installed helpers refuse another instance's sudo caller, missing records and mismatched accounts", async (t) => {
  const { sys, own, calls, accounts } = await twoInstances(t);
  for (const [instance, sudoUser] of [
    [own, "alice"],
    [sys, "bob"],
  ]) {
    for (const [name, argv] of [
      ["devchain-host-update", ["0.25.0"]],
      ["devchain-host-update", ["--clis", "0.24.0"]],
      ["devchain-host-update", ["--fence", "set", "operation-1"]],
      ["devchain-host-project-root", ["/srv/work"]],
    ]) {
      const before = calls.length;
      const result = await execute(name, argv, sys, instance, { sudoUser });
      assert.equal(result.exitCode, 3);
      assert.equal(JSON.parse(result.stderr).code, "INSTANCE_MISMATCH");
      assert.equal(result.stdout, "");
      assert.equal(calls.length, before);
    }
  }
  const claimFile = path.join(own.paths.etcDir, "claim.json");
  const contents = fs.readFileSync(claimFile);
  fs.rmSync(claimFile);
  for (const argv of [["0.25.0"], ["--clis", "0.24.0"]]) {
    const result = await execute("devchain-host-update", argv, sys, own);
    assert.equal(result.exitCode, 3);
    assert.ok(
      ["NOT_CLAIMED", "JOIN_NOT_FOUND"].includes(
        JSON.parse(result.stderr).code,
      ),
    );
  }
  await reserveJoin(
    {
      userName: "bob",
      homePath: accounts.get("bob").home,
      port: 3000,
      requestId: "unused-join",
    },
    sys,
  );
  const unused = await execute(
    "devchain-host-update",
    ["--clis", "0.24.0"],
    sys,
    own,
  );
  assert.equal(unused.exitCode, 3);
  assert.equal(JSON.parse(unused.stderr).code, "NOT_CLAIMED");
  fs.writeFileSync(claimFile, JSON.stringify(readClaim(sys)));
  await assert.rejects(requireHelperInstance(own, { sudoUser: null }), {
    code: "INSTANCE_MISMATCH",
  });
  fs.writeFileSync(claimFile, contents);
  const bob = accounts.get("bob");
  accounts.set("bob", { ...bob, home: "/home/wrong" });
  await assert.rejects(requireHelperInstance(own, { sudoUser: null }), {
    code: "INSTANCE_MISMATCH",
  });
  accounts.delete("bob");
  await assert.rejects(requireHelperInstance(own, { sudoUser: null }), {
    code: "INSTANCE_MISMATCH",
  });
});

test("installed fence mode accepts only the owner helper and returns its JSON contract", async (t) => {
  const { sys, own } = await twoInstances(t);
  const set = await execute(
    "devchain-host-update",
    ["--fence", "set", "operation-1"],
    sys,
    sys,
    { sudoUser: "alice" },
  );
  assert.equal(set.exitCode, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout), {
    fence: {
      ownerUser: "alice",
      operationId: "operation-1",
      expiresAt: "2026-09-24T10:30:00.000Z",
    },
  });
  const rejected = await execute(
    "devchain-host-update",
    ["--fence", "clear", "operation-1"],
    sys,
    own,
    { sudoUser: "bob" },
  );
  assert.equal(rejected.exitCode, 4);
  assert.equal(JSON.parse(rejected.stderr).code, "VM_OWNER_REQUIRED");
  const clear = await execute(
    "devchain-host-update",
    ["--fence", "clear", "operation-1"],
    sys,
    sys,
    { sudoUser: "alice" },
  );
  assert.equal(clear.exitCode, 0, clear.stderr);
  assert.deepEqual(JSON.parse(clear.stdout), { fence: null });
  assert.equal(
    fs.existsSync(path.join(sys.paths.registryDir, "fence.json")),
    false,
  );
});

test("the --clis helper refreshes B's template, Syncthing and SSH PATH without changing A", async (t) => {
  const { sys, own, calls } = await twoInstances(t);
  const beforeA = legacyFiles(sys).map(snapshot);
  const template = path.join(
    own.paths.helperPrefix,
    "lib/node_modules/devchain-host-bootstrap/systemd/devchain-host.service",
  );
  fs.appendFileSync(template, "\nCPUAccounting=yes\n");
  fs.rmSync(path.join(sys.paths.profileDir, "devchain-instance-path.sh"));
  const start = calls.length;
  const result = await execute(
    "devchain-host-update",
    ["--clis", "0.24.0"],
    sys,
    own,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /^devchain-user-bob.service refreshed/);
  const unit = fs.readFileSync(
    path.join(sys.paths.systemdDir, own.paths.unitName),
    "utf8",
  );
  assert.match(unit, /^CPUAccounting=yes$/m);
  assert.ok(
    unit.includes(`Environment=DEVCHAIN_HOST_ETC_DIR=${own.paths.etcDir}`),
  );
  assert.ok(
    unit.includes(
      `Environment=DEVCHAIN_HOST_SYNCTHING_BINARY=${own.paths.binDir}/syncthing`,
    ),
  );
  const binary = path.join(own.paths.binDir, "syncthing");
  assert.equal(mode(binary), 0o750);
  assert.equal(fs.readFileSync(binary, "utf8"), "syncthing v2");
  assert.ok(
    calls
      .slice(start)
      .some(
        (call) =>
          call[0] === "chown" &&
          call[1] === "root:bob" &&
          call[2].startsWith(own.paths.binDir),
      ),
  );
  assert.ok(
    calls
      .slice(start)
      .some(
        (call) =>
          call[0] === "setcap" &&
          call[1] === "cap_chown,cap_fowner,cap_dac_override+ep" &&
          call[2].startsWith(own.paths.binDir),
      ),
  );
  assert.ok(
    calls
      .slice(start)
      .some(
        (call) => call[0] === "getcap" && call[1].startsWith(own.paths.binDir),
      ),
  );
  assert.deepEqual(legacyFiles(sys).map(snapshot), beforeA);
  const profile = path.join(sys.paths.profileDir, "devchain-instance-path.sh");
  const beforeProfile = fs.statSync(profile, { bigint: true });
  ensureInstanceProfile(own);
  assert.equal(fs.statSync(profile, { bigint: true }).ino, beforeProfile.ino);
  assert.equal(
    fs.statSync(profile, { bigint: true }).mtimeNs,
    beforeProfile.mtimeNs,
  );
  assert.ok(
    fs
      .readFileSync(profile, "utf8")
      .includes(`${sys.paths.hostInstallRoot}/instances/$(id -un)/bin`),
  );
  fs.rmSync(profile);
  fs.symlinkSync(path.join(sys.paths.profileDir, "devchain-ids.sh"), profile);
  assert.throws(() => ensureInstanceProfile(own), { code: "SYMLINK_REFUSED" });
});
