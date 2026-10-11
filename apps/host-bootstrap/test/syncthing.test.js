"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performClaim, readClaim } = require("../lib/claim");
const { runUpdate, readStatus } = require("../lib/update");
const { installPrivilegedSyncthing } = require("../lib/syncthing");
const { fakeSystem, mode } = require("./helpers");

// For the acceptance/security cases below, real temporary files and claim/update
// entry points with mocked account/capability commands are the cheapest reliable
// layer for trust checks, rename and cleanup. Actual Linux capability execution
// belongs to the real-Syncthing external specs in local-app's file-sync module.

function binary(sys) {
  return path.join(sys.paths.installRoot, "bin/syncthing");
}

function claimRecord(sys) {
  fs.mkdirSync(sys.paths.etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(sys.paths.etcDir, "claim.json"),
    JSON.stringify({
      userName: "alice",
      homePath: "/Users/alice",
      version: "0.24.0",
      port: 3000,
    }),
  );
}

function setup(t, options = {}) {
  const fixture = fakeSystem({
    users: [{ name: "alice", uid: 501, gid: 20, home: "/Users/alice" }],
    groups: [{ name: "dialout", gid: 20 }],
    ...options,
  });
  t.after(fixture.cleanup);
  return fixture;
}

async function captureStderr(action) {
  let output = "";
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    await action();
  } finally {
    process.stderr.write = write;
  }
  return output;
}

test("today's fresh claim caller installs the copy before the claim record exists", async (t) => {
  const { sys, root, calls, owners } = setup(t, { users: [] });
  const run = sys.run;
  sys.run = async (command, args, options) => {
    if (command === "setcap") assert.equal(readClaim(sys), null);
    return run(command, args, options);
  };
  await performClaim(
    {
      userName: "alice",
      homePath: path.join(root, "Users/alice"),
      uid: 501,
      gid: 20,
      version: "0.24.0",
      port: 3000,
      env: {},
      files: [],
    },
    sys,
    () => {},
  );
  assert.equal(mode(binary(sys)), 0o750);
  assert.equal(fs.readFileSync(binary(sys), "utf8"), "syncthing v2");
  const setcap = calls.find(([command]) => command === "setcap");
  assert.equal(setcap[1], "cap_chown,cap_fowner,cap_dac_override+ep");
  assert.notEqual(setcap[2], binary(sys));
  assert.equal(path.dirname(setcap[2]), path.dirname(binary(sys)));
  assert.equal(owners.get(setcap[2]), "root:dialout");
  assert.deepEqual(
    calls
      .filter(([c]) => ["chown", "setcap", "getcap"].includes(c))
      .map(([c]) => c),
    ["chown", "setcap", "getcap"],
  );
  assert.equal(fs.existsSync(setcap[2]), false);
});

test("Update VM replaces the inode after verifying the staged copy", async (t) => {
  const { sys } = setup(t);
  claimRecord(sys);
  await installPrivilegedSyncthing(sys);
  const fd = fs.openSync(binary(sys), "r");
  t.after(() => fs.closeSync(fd));
  const oldInode = fs.fstatSync(fd).ino;
  fs.writeFileSync(sys.paths.syncthingBinary, "syncthing upgraded");
  const run = sys.run;
  sys.run = async (command, args, options) => {
    if (command === "getcap") {
      assert.equal(fs.statSync(binary(sys)).ino, oldInode);
      assert.equal(fs.readFileSync(binary(sys), "utf8"), "syncthing v2");
      assert.equal(mode(args[0]), 0o750);
    }
    return run(command, args, options);
  };
  await runUpdate("0.25.0", sys);
  assert.equal(readStatus(sys).state, "done");
  assert.notEqual(fs.statSync(binary(sys)).ino, oldInode);
  assert.equal(fs.readFileSync(fd, "utf8"), "syncthing v2");
  assert.equal(fs.readFileSync(binary(sys), "utf8"), "syncthing upgraded");
});

for (const failure of ["account", "setcap"]) {
  test(`fresh claim succeeds with one warning and no copy after ${failure} failure`, async (t) => {
    const { sys, root } = setup(t, { users: [] });
    const run = sys.run;
    sys.run = async (command, args, options) => {
      if (command === "stat" && failure === "account")
        return { stdout: "1000:440\n", stderr: "" };
      if (command === "setcap" && failure === "setcap")
        throw new Error("setcap failed");
      return run(command, args, options);
    };
    const stderr = await captureStderr(() =>
      performClaim(
        {
          userName: "alice",
          homePath: path.join(root, "Users/alice"),
          uid: 501,
          gid: 20,
          version: "0.24.0",
          port: 3000,
          env: {},
          files: [],
        },
        sys,
        () => {},
      ),
    );
    assert.equal(readClaim(sys).version, "0.24.0");
    assert.match(stderr, /^privileged Syncthing unavailable: /);
    assert.equal(stderr.trim().split("\n").length, 1);
    assert.equal(fs.existsSync(binary(sys)), false);
    if (fs.existsSync(path.dirname(binary(sys))))
      assert.deepEqual(fs.readdirSync(path.dirname(binary(sys))), []);
  });
}

for (const failure of ["account", "setcap", "getcap", "mismatch"]) {
  test(`Update VM succeeds with one warning and no copy after ${failure} failure`, async (t) => {
    const { sys } = setup(t);
    claimRecord(sys);
    await installPrivilegedSyncthing(sys);
    const run = sys.run;
    sys.run = async (command, args, options) => {
      if (command === failure)
        throw new Error(`${failure} failed\nsecond line`);
      if (command === "getcap" && failure === "mismatch")
        return { stdout: `${args[0]} cap_chown=ep\n`, stderr: "" };
      return run(command, args, options);
    };
    if (failure === "account") sys.lookupUser = async () => null;
    const stderr = await captureStderr(() => runUpdate("0.25.0", sys));
    assert.equal(readStatus(sys).state, "done");
    assert.match(stderr, /^privileged Syncthing unavailable: /);
    assert.equal(stderr.trim().split("\n").length, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(binary(sys))), []);
  });
}

for (const scenario of [
  "missing",
  "invalid name",
  "system uid",
  "non-root owner",
  "group writable",
  "other writable",
  "symlink",
  "invalid JSON",
]) {
  test(`account validation rejects ${scenario} without setting capabilities`, async (t) => {
    const { sys, calls, accounts, root } = setup(t);
    claimRecord(sys);
    const file = path.join(sys.paths.etcDir, "claim.json");
    if (scenario === "missing") fs.rmSync(file);
    if (scenario === "invalid name")
      fs.writeFileSync(file, '{"userName":"--root"}');
    if (scenario === "system uid") accounts.get("alice").uid = 499;
    if (scenario === "invalid JSON") fs.writeFileSync(file, "{");
    if (scenario === "group writable") fs.chmodSync(file, 0o664);
    if (scenario === "other writable") fs.chmodSync(file, 0o646);
    if (scenario === "symlink") {
      fs.renameSync(file, path.join(root, "record"));
      fs.symlinkSync(path.join(root, "record"), file);
    }
    const run = sys.run;
    sys.run = async (command, args, options) =>
      command === "stat" && scenario === "non-root owner"
        ? { stdout: "1000:644\n", stderr: "" }
        : run(command, args, options);
    const stderr = await captureStderr(() => installPrivilegedSyncthing(sys));
    assert.equal(stderr.trim().split("\n").length, 1);
    assert.equal(fs.existsSync(binary(sys)), false);
    assert.equal(
      calls.some(([command]) => command === "setcap"),
      false,
    );
  });
}

// Configuration contract: the shipped package inputs must supply setcap/getcap.
test("libcap2-bin is a required package in the shipped host inputs", () => {
  const versions = fs.readFileSync(
    path.join(__dirname, "../../host-image/versions.env"),
    "utf8",
  );
  const packages = versions
    .match(/^DEVCHAIN_REQUIRED_PACKAGES=(.*)$/m)[1]
    .split(/\s+/);
  assert.ok(packages.includes("libcap2-bin"));
});
