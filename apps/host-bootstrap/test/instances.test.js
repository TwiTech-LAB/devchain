"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createInstanceSystem,
  createInstalledSystem,
} = require("../lib/system");
const { readClaim } = require("../lib/claim");
const {
  reserveJoin,
  cancelJoin,
  expireJoin,
  beginJoinClaim,
  readReservation,
  readRegistry,
  JOIN_TTL_MS,
} = require("../lib/instances");
const { fakeSystem, mode } = require("./helpers");

// Fake-system tests cover registry decisions and file boundaries without root or systemd.
function claimed(t, options) {
  const fake = fakeSystem(options);
  t.after(fake.cleanup);
  const file = path.join(fake.sys.paths.etcDir, "claim.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      userName: "alice",
      homePath: "/Users/alice",
      port: 3000,
      version: "0.25.0",
    }),
  );
  return fake;
}

function joinRequest(userName = "bob", over = {}) {
  return {
    userName,
    homePath: `/Users/${userName}`,
    port: 3000,
    requestId: `request-${userName}`,
    ...over,
  };
}

test("port allocation skips legacy claims, joined claims, reservations and IPv4/IPv6 listeners", async (t) => {
  const { sys } = claimed(t);
  const joined = createInstanceSystem(sys, "carol");
  fs.mkdirSync(joined.paths.etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(joined.paths.etcDir, "claim.json"),
    JSON.stringify({ userName: "carol", homePath: "/Users/carol", port: 3001 }),
  );
  const first = await reserveJoin(joinRequest("dave"), sys);
  assert.equal(first.port, 3002);
  const run = sys.run;
  sys.run = (command, args, ...rest) =>
    command === "ss"
      ? Promise.resolve({
          stdout:
            "LISTEN 0 511 0.0.0.0:3003 0.0.0.0:*\nLISTEN 0 511 [::]:3004 [::]:*\n",
        })
      : run(command, args, ...rest);
  assert.equal((await reserveJoin(joinRequest(), sys)).port, 3005);
  assert.equal(
    (await reserveJoin(joinRequest("eve", { port: 4100 }), sys)).port,
    4100,
  );
});

test("concurrent joins reserve different ports under the host flock", async (t) => {
  const { sys } = claimed(t);
  const results = await Promise.all([
    reserveJoin(joinRequest(), sys),
    reserveJoin(joinRequest("carol"), sys),
  ]);
  assert.deepEqual(results.map((result) => result.port).sort(), [3001, 3002]);
  assert.equal((await readRegistry(sys)).length, 3);
});

test("requestId retry resumes the same root-only secret, port and expiry and restarts its persistent unit", async (t) => {
  const { sys, calls } = claimed(t);
  const result = await reserveJoin(joinRequest(), sys);
  const own = createInstanceSystem(sys, "bob");
  const reservation = await readReservation(own);
  assert.equal(reservation.nonce, undefined);
  assert.match(reservation.nonceHash, /^[a-f0-9]{64}$/);
  assert.equal(mode(path.join(own.paths.etcDir, "join.nonce")), 0o600);
  assert.equal(mode(path.join(own.paths.etcDir, "join.json")), 0o600);
  const unit = fs.readFileSync(
    path.join(sys.paths.systemdDir, "devchain-join-bob.service"),
    "utf8",
  );
  assert.ok(
    unit.includes(`ConditionPathExists=!${own.paths.etcDir}/claim.json`),
  );
  assert.ok(
    unit.includes(
      `ExecStart=${own.paths.helperPrefix}/bin/devchain-bootstrap --join bob`,
    ),
  );
  assert.match(unit, /^Restart=on-failure$/m);
  assert.doesNotMatch(unit, new RegExp(result.nonce));
  sys.now = () => new Date("2026-09-24T10:30:00Z");
  assert.deepEqual(
    await reserveJoin(joinRequest("bob", { port: 3999 }), sys),
    result,
  );
  assert.equal(
    calls.filter(
      (call) =>
        call.join(" ") === "systemctl enable --now devchain-join-bob.service",
    ).length,
    2,
  );
});

test("duplicate legacy and reserved names report INSTANCE_EXISTS with the user and port", async (t) => {
  const { sys } = claimed(t);
  const result = await reserveJoin(joinRequest(), sys);
  for (const [request, port] of [
    [joinRequest("alice"), 3000],
    [joinRequest("bob", { requestId: "another-request" }), result.port],
  ]) {
    await assert.rejects(
      reserveJoin(request, sys),
      (error) =>
        error.status === 409 &&
        error.code === "INSTANCE_EXISTS" &&
        error.message ===
          `This VM already runs DevChain for ${request.userName} on port ${port}.`,
    );
  }
});

test("account home collisions retain USER_EXISTS and HOME_EXISTS refusals", async (t) => {
  const { sys, root } = claimed(t, {
    users: [{ name: "bob", uid: 1001, gid: 1001, home: "/home/bob" }],
  });
  await assert.rejects(reserveJoin(joinRequest(), sys), {
    code: "USER_EXISTS",
  });
  const existingHome = path.join(root, "home-exists");
  const stat = fs.promises.stat;
  fs.mkdirSync(existingHome);
  t.mock.method(fs.promises, "stat", async (file, ...args) =>
    stat(file === "/Users/carol" ? existingHome : file, ...args),
  );
  await assert.rejects(reserveJoin(joinRequest("carol"), sys), {
    code: "HOME_EXISTS",
  });
});

test("an expired join frees its port and removes its reservation, nonce and unit", async (t) => {
  const { sys, calls } = claimed(t);
  const original = await reserveJoin(joinRequest(), sys);
  const own = createInstanceSystem(sys, "bob");
  own.now = sys.now = () => new Date(Date.parse(original.expiresAt));
  assert.equal(await expireJoin(own), true);
  for (const file of [
    path.join(own.paths.etcDir, "join.json"),
    path.join(own.paths.etcDir, "join.nonce"),
    path.join(sys.paths.systemdDir, own.paths.joinUnitName),
  ])
    assert.equal(fs.existsSync(file), false);
  assert.ok(
    calls.some(
      (call) =>
        call.join(" ") ===
        "systemctl stop --no-block devchain-join-bob.service",
    ),
  );
  assert.equal(
    (await reserveJoin(joinRequest("carol"), sys)).port,
    original.port,
  );
});

test("a claim started before expiry retains its reservation and cannot be cancelled", async (t) => {
  const { sys } = claimed(t);
  const join = await reserveJoin(joinRequest(), sys);
  const own = createInstanceSystem(sys, "bob");
  await beginJoinClaim(join, own);
  own.now = () => new Date(Date.parse(join.expiresAt) + JOIN_TTL_MS);
  assert.equal(await expireJoin(own), false);
  assert.equal(
    (await readReservation(own)).claimStartedAt,
    "2026-09-24T10:00:00.000Z",
  );
  await assert.rejects(cancelJoin(join, sys), { code: "CLAIM_STARTED" });
});

test("cancel before claim removes only the matching instance and is idempotent", async (t) => {
  const { sys } = claimed(t);
  const bob = await reserveJoin(joinRequest(), sys);
  const carol = await reserveJoin(joinRequest("carol"), sys);
  await assert.rejects(
    cancelJoin({ userName: "bob", requestId: "wrong" }, sys),
    { code: "INSTANCE_EXISTS" },
  );
  assert.deepEqual(await cancelJoin(bob, sys), { cancelled: true });
  assert.deepEqual(await cancelJoin(bob, sys), { cancelled: true });
  const own = createInstanceSystem(sys, "bob");
  assert.equal(fs.existsSync(own.paths.installRoot), false);
  assert.equal(fs.existsSync(own.paths.etcDir), false);
  assert.equal(
    (await readReservation(createInstanceSystem(sys, "carol"))).port,
    carol.port,
  );
  assert.equal(readClaim(sys).userName, "alice");
});

test("missing or mismatched joined records fail without falling back to legacy", async (t) => {
  const { sys } = claimed(t);
  const own = createInstanceSystem(sys, "bob");
  assert.equal(readClaim(own), null);
  await assert.rejects(beginJoinClaim({ userName: "bob" }, own), {
    code: "JOIN_NOT_FOUND",
  });
  fs.mkdirSync(own.paths.etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(own.paths.etcDir, "claim.json"),
    JSON.stringify(readClaim(sys)),
  );
  assert.throws(() => readClaim(own), { code: "INSTANCE_MISMATCH" });
  await assert.rejects(readRegistry(sys), { code: "INSTANCE_MISMATCH" });
});

test("installed helper paths resolve a joined identity and reject an unknown prefix", (t) => {
  const { sys } = claimed(t);
  const own = createInstanceSystem(sys, "bob");
  const resolved = createInstalledSystem(
    path.join(
      own.paths.helperPrefix,
      "lib/node_modules/devchain-host-bootstrap",
    ),
    sys,
  );
  assert.deepEqual(resolved.paths, {
    ...own.paths,
    unitTemplate: path.join(
      own.paths.helperPrefix,
      "lib/node_modules/devchain-host-bootstrap/systemd/devchain-host.service",
    ),
  });
  assert.notEqual(resolved.paths.helperPrefix, resolved.paths.cliPrefix);
  assert.equal(resolved.paths.unitName, "devchain-user-bob.service");
  assert.equal(resolved.paths.sudoersName, "devchain-user-bob");
  assert.equal(resolved.paths.updateUnitName, "devchain-update-bob");
  assert.equal(resolved.paths.dockerUnitName, "devchain-docker-bob");
  assert.throws(() => createInstalledSystem("/tmp/unknown-helper", sys), {
    code: "INSTANCE_MISMATCH",
  });
});

test("listener inspection failure refuses allocation instead of assuming ports are free", async (t) => {
  const { sys } = claimed(t, { failOn: (command) => command === "ss" });
  await assert.rejects(reserveJoin(joinRequest(), sys), {
    code: "PORT_CHECK_FAILED",
  });
  assert.equal(await readReservation(createInstanceSystem(sys, "bob")), null);
});

test("a full port range refuses allocation without writing a reservation", async (t) => {
  const { sys } = claimed(t);
  const run = sys.run;
  sys.run = (command, args, ...rest) =>
    command === "ss"
      ? Promise.resolve({
          stdout: Array.from(
            { length: 1000 },
            (_, i) => `LISTEN 0 511 *:${3000 + i} *:*`,
          ).join("\n"),
        })
      : run(command, args, ...rest);
  await assert.rejects(reserveJoin(joinRequest(), sys), {
    code: "NO_INSTANCE_PORT",
  });
  assert.equal(await readReservation(createInstanceSystem(sys, "bob")), null);
});
