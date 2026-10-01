"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");
const { createBootstrap } = require("../lib/server");
const { CERT_NAME } = require("../lib/tls");
const { fakeSystem, fixtureTls, OTHER_TLS } = require("./helpers");

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
