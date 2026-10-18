"use strict";

// Fake-system integration exercises atomic files and the existing registry lock without root/systemd.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { fakeSystem, mode } = require("./helpers");
const { createInstanceSystem } = require("../lib/system");
const { destroyFence, readFence, FENCE_TTL_MS } = require("../lib/fence");
const { reserveJoin, beginJoinClaim } = require("../lib/instances");
const { performClaim } = require("../lib/claim");

function claimed(t, options = {}) {
  const fake = fakeSystem({
    ...options,
    users: [{ name: "alice", uid: 1001, gid: 1001, home: "/Users/alice" }],
  });
  t.after(fake.cleanup);
  fs.writeFileSync(
    path.join(fake.sys.paths.etcDir, "claim.json"),
    JSON.stringify({
      userName: "alice",
      homePath: "/Users/alice",
      port: 3000,
      version: "0.25.0",
    }),
  );
  return fake;
}
const request = {
  userName: "bob",
  homePath: "/Users/bob",
  port: 3001,
  requestId: "join-bob",
};

test("owner helper writes a public root-owned VM-wide fence, refreshes expiry and clears only its operation", async (t) => {
  const { sys, owners } = claimed(t);
  const result = await destroyFence("set", "operation-1", sys);
  const file = path.join(sys.paths.registryDir, "fence.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), result.fence);
  assert.equal(result.fence.ownerUser, "alice");
  assert.equal(
    Date.parse(result.fence.expiresAt),
    sys.now().getTime() + FENCE_TTL_MS,
  );
  assert.equal(mode(file), 0o644);
  assert.ok([...owners.values()].includes("0:0"));
  sys.now = () => new Date("2026-09-24T10:05:00.000Z");
  const refreshed = await destroyFence("set", "operation-2", sys);
  assert.equal(refreshed.fence.expiresAt, "2026-09-24T10:35:00.000Z");
  await assert.rejects(destroyFence("clear", "operation-1", sys), {
    code: "VM_FENCE_OPERATION_MISMATCH",
  });
  assert.deepEqual(await readFence(sys), refreshed.fence);
  assert.deepEqual(await destroyFence("clear", "operation-2", sys), {
    fence: null,
  });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await destroyFence("clear", "operation-2", sys), {
    fence: null,
  });
});

test("joined helper cannot change the owner's fence even when called by root", async (t) => {
  const { sys, accounts } = claimed(t);
  const own = createInstanceSystem(sys, "bob");
  accounts.set("bob", {
    name: "bob",
    uid: 1002,
    gid: 1002,
    home: "/Users/bob",
  });
  fs.mkdirSync(own.paths.etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(own.paths.etcDir, "claim.json"),
    JSON.stringify({ ...request }),
  );
  await assert.rejects(destroyFence("set", "operation-1", own), {
    code: "VM_OWNER_REQUIRED",
  });
  assert.equal(await readFence(sys), null);
});

test("fence refuses new joins and reserved claims with the owner name, then admits joins at expiry", async (t) => {
  const { sys } = claimed(t);
  const reservation = await reserveJoin(request, sys);
  await destroyFence("set", "operation-1", sys);
  const refusal = (error) =>
    error.code === "VM_DESTROY_PENDING" && error.message.includes("alice");
  await assert.rejects(
    reserveJoin(
      {
        ...request,
        userName: "carol",
        homePath: "/Users/carol",
        requestId: "join-carol",
      },
      sys,
    ),
    refusal,
  );
  await assert.rejects(
    beginJoinClaim(
      { ...request, nonce: reservation.nonce },
      createInstanceSystem(sys, "bob"),
    ),
    refusal,
  );
  sys.now = () => new Date("2026-09-24T10:30:00.000Z");
  assert.equal(await readFence(sys), null);
  const next = await reserveJoin(
    {
      ...request,
      userName: "carol",
      homePath: "/Users/carol",
      requestId: "join-carol",
    },
    sys,
  );
  assert.equal(next.userName, "carol");
});

test("a fence written during join installation refuses the final claim record", async (t) => {
  const { sys, root } = claimed(t, { rootParent: os.homedir() });
  const pending = { ...request, homePath: path.join(root, "bob-home") };
  const reservation = await reserveJoin(pending, sys);
  const own = createInstanceSystem(sys, "bob");
  const run = own.run;
  own.run = async (...args) => {
    if (args[0] === "systemctl" && args[1][0] === "enable") {
      await destroyFence("set", "operation-1", sys);
    }
    return run(...args);
  };
  await assert.rejects(
    performClaim(
      {
        ...pending,
        nonce: reservation.nonce,
        version: "0.25.0",
        env: {},
        files: [],
      },
      own,
      () => {},
    ),
    (error) =>
      error.code === "VM_DESTROY_PENDING" && error.message.includes("alice"),
  );
  assert.equal(fs.existsSync(path.join(own.paths.etcDir, "claim.json")), false);
});

test("invalid helper arguments and corrupt fences fail closed", async (t) => {
  const { sys } = claimed(t);
  await assert.rejects(destroyFence("set", "../other", sys), {
    code: "INVALID_ARGUMENT",
  });
  fs.writeFileSync(path.join(sys.paths.registryDir, "fence.json"), "{}");
  await assert.rejects(reserveJoin(request, sys), { code: "VM_FENCE_INVALID" });
});
