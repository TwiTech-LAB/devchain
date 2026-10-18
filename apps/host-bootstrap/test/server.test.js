"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createBootstrap } = require("../lib/server");
const { performClaim, readClaim } = require("../lib/claim");
const { createInstanceSystem } = require("../lib/system");
const { reserveJoin, readReservation } = require("../lib/instances");
const { CERT_NAME } = require("../lib/tls");
const { fakeSystem, fixtureTls, OTHER_TLS, snapshot } = require("./helpers");

const CLAIM = {
  userName: "alice",
  homePath: "/Users/alice",
  version: "0.24.0",
  port: 3100,
};

/** One HTTPS request that trusts only `ca`, as home's pinned client does. */
function request(port, method, urlPath, { body, ca = fixtureTls.cert } = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        ca,
        servername: CERT_NAME,
        agent: false,
        headers: text
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(text),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

/** A stand-in DevChain answering /api/runtime on the port the claim names. */
function fakeDevChainFetch(version) {
  return async (url) => {
    assert.equal(url, "http://127.0.0.1:3100/api/runtime");
    return { ok: true, json: async () => ({ version }) };
  };
}

async function start(t, options) {
  const done = [];
  const bootstrap = createBootstrap({
    handoverTimeoutMs: 300,
    onDone: () => done.push(true),
    ...options,
  });
  await new Promise((resolve) =>
    bootstrap.server.listen(0, "127.0.0.1", resolve),
  );
  await bootstrap.ready;
  const { port } = bootstrap.server.address();
  t.after(() => bootstrap.server.close());
  const call = (method, urlPath, body) =>
    request(port, method, urlPath, { body });
  return { bootstrap, call, done, port };
}

test("an unclaimed VM answers /api/runtime with the image version and no DevChain version", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  const { call } = await start(t, { sys });
  const { status, body } = await call("GET", "/api/runtime");
  assert.equal(status, 200);
  assert.equal(body.state, "unclaimed");
  assert.equal(body.version, null);
  assert.equal(body.imageVersion, "1.0.0");
  assert.match(body.bootId, /^[0-9a-f-]{36}$/);
  assert.equal((await call("GET", "/api/host/stats")).status, 404);
});

test("a claim hands the port over and answers once DevChain runs the version", async (t) => {
  const { sys, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  sys.fetch = fakeDevChainFetch("0.24.0");
  const claimed = [];
  const { call, done, bootstrap } = await start(t, {
    sys,
    claimFn: async (claim) => {
      claimed.push(claim);
      return { ...CLAIM, claimedAt: "now" };
    },
  });

  const { status, body } = await call("POST", "/api/host/claim", CLAIM);

  assert.equal(status, 200);
  assert.deepEqual(body, { claimed: true, ...CLAIM, claimedAt: "now" });
  assert.equal(claimed[0].userName, "alice");
  assert.deepEqual(calls.at(-1), [
    "systemctl",
    "start",
    "--no-block",
    "devchain-host.service",
  ]);
  assert.equal(bootstrap.state, "handover");
  assert.equal(bootstrap.server.listening, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(done, [true]);
});

test("DevChain not answering in time is a 504 after the claim is recorded", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  sys.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const { call } = await start(t, { sys, claimFn: async () => ({ ...CLAIM }) });
  const { status, body } = await call("POST", "/api/host/claim", CLAIM);
  assert.equal(status, 504);
  assert.equal(body.code, "HOST_START_TIMEOUT");
});

test("a claim while one is running is a 409, and a failed claim can be retried", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  sys.fetch = fakeDevChainFetch("0.24.0");
  let release;
  let attempt = 0;
  const { call } = await start(t, {
    sys,
    claimFn: async () => {
      attempt += 1;
      if (attempt === 1)
        throw Object.assign(new Error("npm down"), { step: "install" });
      await new Promise((resolve) => (release = resolve));
      return { ...CLAIM };
    },
  });

  const failed = await call("POST", "/api/host/claim", CLAIM);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body.details, { step: "install" });

  const running = call("POST", "/api/host/claim", CLAIM);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await call("POST", "/api/host/claim", CLAIM);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "ALREADY_CLAIMED");
  assert.equal((await call("GET", "/api/runtime")).body.state, "claiming");
  release();
  assert.equal((await running).status, 200);
});

test("an invalid claim is refused before anything runs", async (t) => {
  const { sys, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  const { call } = await start(t, {
    sys,
    claimFn: async () => assert.fail("must not run"),
  });
  const { status, body } = await call("POST", "/api/host/claim", {
    ...CLAIM,
    homePath: "/etc",
  });
  assert.equal(status, 400);
  assert.equal(body.code, "INVALID_CLAIM");
  assert.equal(calls.length, 0);
});

test("the claim body is never written to the log", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  sys.fetch = fakeDevChainFetch("0.24.0");
  const written = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return write.call(process.stdout, chunk, ...rest);
  };
  t.after(() => (process.stdout.write = write));
  const { call } = await start(t, { sys, claimFn: async () => ({ ...CLAIM }) });
  await call("POST", "/api/host/claim", {
    ...CLAIM,
    providerAuth: {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-never-logged" },
      files: [
        {
          path: "/Users/alice/.codex/auth.json",
          contentBase64: Buffer.from("file-never-logged").toString("base64"),
        },
      ],
    },
  });
  process.stdout.write = write;
  const log = written.join("");
  assert.match(log, /claim started/);
  assert.doesNotMatch(log, /never-logged|c2stbmV2ZXI|ZmlsZS1uZXZlcg/);
});

test("a body over 1 MiB is refused", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  const { port } = await start(t, {
    sys,
    claimFn: async () => assert.fail("must not run"),
  });
  const status = await new Promise((resolve) => {
    const req = https.request(
      {
        port,
        method: "POST",
        path: "/api/host/claim",
        ca: fixtureTls.cert,
        servername: CERT_NAME,
        agent: false,
      },
      (res) => resolve(res.statusCode),
    );
    req.on("error", () => resolve("reset"));
    req.end("x".repeat(2 * 1024 * 1024));
  });
  assert.ok(status === 413 || status === "reset", `got ${status}`);
});

test("the bootstrap serves HTTPS only: plaintext HTTP gets no answer", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  const { port } = await start(t, { sys });
  const outcome = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/runtime", agent: false },
      (res) => resolve(`answered ${res.statusCode}`),
    );
    req.setTimeout(2_000, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve(`error ${error.code ?? error.message}`));
    req.end();
  });
  assert.match(outcome, /^error /);
});

test("a client that trusts another certificate refuses the bootstrap", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  const { port } = await start(t, { sys });
  await assert.rejects(
    request(port, "GET", "/api/runtime", {
      ca: fs.readFileSync(path.join(OTHER_TLS, "cert.pem")),
    }),
    /self[- ]signed|unable to verify|certificate/i,
  );
});

test("the bootstrap does not start without the VM certificate", (t) => {
  const { sys, cleanup } = fakeSystem({ tls: false });
  t.after(cleanup);
  assert.throws(
    () => createBootstrap({ sys }),
    (error) =>
      error.code === "TLS_UNAVAILABLE" &&
      /has no certificate/.test(error.message),
  );
});

// The HTTPS seam exercises validation and handover with real claim filesystem work;
// only OS commands are faked, so sibling file changes remain observable.
test("a second HTTPS claim creates an independent instance and leaves the legacy instance unchanged", async (t) => {
  const homeParent = /^\/(home|Users|var\/home)\//.test(os.homedir())
    ? os.homedir()
    : "/home";
  const { sys, root, calls, cleanup } = fakeSystem({ rootParent: homeParent });
  t.after(cleanup);
  const legacyClaim = {
    ...CLAIM,
    homePath: path.join(root, "Users/alice"),
    env: {},
    files: [],
  };
  await performClaim(legacyClaim, sys, () => {});
  const legacyPaths = [
    path.join(sys.paths.etcDir, "claim.json"),
    path.join(sys.paths.systemdDir, "devchain-host.service"),
    path.join(sys.paths.sudoersDir, "devchain-host"),
    path.join(sys.paths.installRoot, "versions"),
    path.join(sys.paths.installRoot, "current"),
    sys.paths.binDir,
    sys.paths.cliPrefix,
    sys.paths.tlsDir,
  ];
  const before = legacyPaths.map(snapshot);
  const homePath = path.join(root, "Users/bob");
  const reservation = await reserveJoin(
    {
      userName: "bob",
      homePath,
      port: legacyClaim.port,
      requestId: "join-bob",
    },
    sys,
  );
  const own = createInstanceSystem(sys, "bob");
  own.fetch = async (url) => {
    assert.equal(url, `http://127.0.0.1:${reservation.port}/api/runtime`);
    return { ok: true, json: async () => ({ version: "0.25.0" }) };
  };
  const { call, done } = await start(t, { sys: own });
  const result = await call("POST", "/api/host/claim", {
    userName: "bob",
    homePath,
    version: "0.25.0",
    port: reservation.port,
    nonce: reservation.nonce,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.claimed, true);
  assert.equal(readClaim(own).port, reservation.port);
  assert.equal(await readReservation(own), null);
  assert.equal(fs.existsSync(path.join(own.paths.etcDir, "join.nonce")), false);
  assert.equal(
    fs.readFileSync(path.join(own.paths.binDir, "devchain"), "utf8"),
    "0.25.0",
  );
  assert.equal(
    fs.readlinkSync(path.join(own.paths.installRoot, "current")),
    "versions/0.25.0",
  );
  assert.equal(
    fs.readFileSync(path.join(own.paths.binDir, "syncthing"), "utf8"),
    "syncthing v2",
  );
  for (const name of ["claude", "codex", "copilot", "opencode", "agy"])
    assert.equal(
      fs.readlinkSync(path.join(own.paths.binDir, name)),
      path.join(own.paths.cliPrefix, "bin", name),
    );
  for (const name of [
    "devchain-bootstrap",
    "devchain-host-update",
    "devchain-host-project-root",
  ])
    assert.equal(
      fs.readlinkSync(path.join(own.paths.binDir, name)),
      path.join(own.paths.helperPrefix, "bin", name),
    );
  const unit = fs.readFileSync(
    path.join(sys.paths.systemdDir, "devchain-user-bob.service"),
    "utf8",
  );
  assert.match(unit, /^User=bob$/m);
  assert.match(unit, /^Group=bob$/m);
  assert.ok(unit.includes(`WorkingDirectory=${homePath}`));
  assert.ok(unit.includes(`--port ${reservation.port}`));
  assert.ok(
    unit.includes(`ConditionPathExists=${own.paths.etcDir}/claim.json`),
  );
  assert.ok(
    unit.includes(`Environment=DEVCHAIN_HOST_ETC_DIR=${own.paths.etcDir}`),
  );
  assert.ok(
    unit.includes(`Environment=DEVCHAIN_HOST_BIN_DIR=${own.paths.binDir}`),
  );
  assert.ok(
    unit.includes(
      `Environment=DEVCHAIN_HOST_SYNCTHING_BINARY=${own.paths.binDir}/syncthing`,
    ),
  );
  assert.ok(unit.includes(`Environment=PATH=${own.paths.binDir}:`));
  assert.ok(
    unit.includes(
      `Environment=DEVCHAIN_HOST_TLS_KEY_FILE=${homePath}/.devchain/tls/key.pem`,
    ),
  );
  assert.ok(
    unit.includes(
      `Environment=DEVCHAIN_HOST_TLS_CERT_FILE=${homePath}/.devchain/tls/cert.pem`,
    ),
  );
  assert.doesNotMatch(unit, /^Conflicts=/m);
  assert.deepEqual(
    fs.readFileSync(path.join(homePath, ".devchain/tls/cert.pem")),
    fixtureTls.cert,
  );
  const sudoers = fs.readFileSync(
    path.join(sys.paths.sudoersDir, "devchain-user-bob"),
    "utf8",
  );
  assert.match(sudoers, /^bob ALL=\(ALL\) NOPASSWD:ALL$/m);
  assert.ok(sudoers.includes(`${own.paths.binDir}/devchain-host-update`));
  assert.ok(sudoers.includes(`${own.paths.binDir}/devchain-host-project-root`));
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "visudo" &&
        call[2] === path.join(sys.paths.sudoersDir, "devchain-user-bob.new"),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.join(" ") ===
        "systemctl start --no-block devchain-user-bob.service",
    ),
  );
  assert.deepEqual(legacyPaths.map(snapshot), before);
  const profile = fs.readFileSync(
    path.join(sys.paths.profileDir, "devchain-instance-path.sh"),
    "utf8",
  );
  assert.ok(
    profile.includes(`${sys.paths.installRoot}/instances/$(id -un)/bin`),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(done, [true]);
});

test("join HTTPS validation refuses a wrong nonce, user, home or port before claiming", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  fs.writeFileSync(
    path.join(sys.paths.etcDir, "claim.json"),
    JSON.stringify({ ...CLAIM }),
  );
  const reservation = await reserveJoin(
    {
      userName: "bob",
      homePath: "/Users/bob",
      port: 3100,
      requestId: "join-bob",
    },
    sys,
  );
  const own = createInstanceSystem(sys, "bob");
  const { call } = await start(t, {
    sys: own,
    claimFn: async () => assert.fail("must not claim"),
  });
  for (const patch of [
    { nonce: "a".repeat(64) },
    { userName: "carol" },
    { homePath: "/home/bob" },
    { port: 3999 },
  ]) {
    const result = await call("POST", "/api/host/claim", {
      ...reservation,
      version: "0.25.0",
      ...patch,
    });
    assert.equal(result.status, 403);
    assert.equal(
      result.body.code,
      patch.nonce ? "INVALID_JOIN_NONCE" : "JOIN_BINDING_MISMATCH",
    );
    assert.equal(
      JSON.stringify(result.body).includes(reservation.nonce),
      false,
    );
  }
  assert.equal((await call("GET", "/api/runtime")).body.state, "unclaimed");
  assert.equal((await readReservation(own)).claimStartedAt, undefined);
});

test("the join bootstrap closes and exits when its unused reservation expires", async (t) => {
  const { sys, cleanup } = fakeSystem();
  t.after(cleanup);
  fs.writeFileSync(
    path.join(sys.paths.etcDir, "claim.json"),
    JSON.stringify({ ...CLAIM }),
  );
  const reservation = await reserveJoin(
    {
      userName: "bob",
      homePath: "/Users/bob",
      port: 3100,
      requestId: "join-bob",
    },
    sys,
  );
  const own = createInstanceSystem(sys, "bob");
  const { bootstrap, done } = await start(t, { sys: own });
  await bootstrap.checkExpiry();
  own.now = () => new Date(reservation.expiresAt);
  await bootstrap.checkExpiry();
  assert.equal(bootstrap.server.listening, false);
  assert.equal(await readReservation(own), null);
  assert.deepEqual(done, [true]);
});
