"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { X509Certificate, createPrivateKey } = require("node:crypto");
const { ensureCertificate, loadTls } = require("../lib/tls");
const { createSystem } = require("../lib/system");
const {
  fakeSystem,
  fixtureTls,
  installTls,
  mode,
  OTHER_TLS,
} = require("./helpers");

function claimVm(sys) {
  fs.mkdirSync(sys.paths.etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(sys.paths.etcDir, "claim.json"),
    JSON.stringify({ userName: "alice" }),
  );
}

const opensslCalls = (calls) =>
  calls.filter(([command]) => command === "openssl");

test("an unclaimed VM without a certificate creates an EC P-256 one for 10 years", async (t) => {
  const { sys, calls, cleanup } = fakeSystem({ tls: false });
  t.after(cleanup);

  assert.equal(await ensureCertificate(sys), "created");

  const [call] = opensslCalls(calls);
  assert.deepEqual(call.slice(0, 13), [
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-sha256",
    "-days",
    "3650",
    "-subj",
    "/CN=devchain-host",
  ]);
  const dir = sys.paths.tlsDir;
  assert.equal(mode(dir), 0o755);
  assert.equal(mode(path.join(dir, "key.pem")), 0o600);
  assert.equal(mode(path.join(dir, "cert.pem")), 0o644);
  assert.deepEqual(loadTls(sys), fixtureTls);
  // Nothing of the staging directory is left beside the result.
  assert.deepEqual(fs.readdirSync(sys.paths.etcDir), ["tls"]);
});

test("a restart keeps the existing certificate", async (t) => {
  const { sys, calls, cleanup } = fakeSystem({ tls: false });
  t.after(cleanup);
  await ensureCertificate(sys);
  const first = loadTls(sys);

  assert.equal(await ensureCertificate(sys), "kept");

  assert.equal(opensslCalls(calls).length, 1);
  assert.deepEqual(loadTls(sys), first);
});

test("an empty certificate directory is filled", async (t) => {
  const { sys, cleanup } = fakeSystem({ tls: false });
  t.after(cleanup);
  fs.mkdirSync(sys.paths.tlsDir, { recursive: true });
  assert.equal(await ensureCertificate(sys), "created");
  assert.deepEqual(loadTls(sys), fixtureTls);
});

test("a claimed VM without a certificate refuses and never creates one", async (t) => {
  const { sys, calls, cleanup } = fakeSystem({ tls: false });
  t.after(cleanup);
  claimVm(sys);

  await assert.rejects(ensureCertificate(sys), (error) => {
    assert.equal(error.code, "TLS_UNAVAILABLE");
    assert.match(error.message, /claimed/);
    return true;
  });
  assert.equal(opensslCalls(calls).length, 0);
  assert.ok(!fs.existsSync(sys.paths.tlsDir));
});

test("a claimed VM keeps its certificate", async (t) => {
  const { sys, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  claimVm(sys);
  assert.equal(await ensureCertificate(sys), "kept");
  assert.equal(opensslCalls(calls).length, 0);
});

for (const [label, prepare] of [
  [
    "only a certificate",
    (dir) => {
      installTls(dir);
      fs.rmSync(path.join(dir, "key.pem"));
    },
  ],
  [
    "a key and another key's certificate",
    (dir) => {
      installTls(dir);
      fs.copyFileSync(
        path.join(OTHER_TLS, "cert.pem"),
        path.join(dir, "cert.pem"),
      );
    },
  ],
  [
    "a certificate that does not parse",
    (dir) => {
      installTls(dir);
      fs.writeFileSync(path.join(dir, "cert.pem"), "not a certificate");
    },
  ],
]) {
  test(`${label} is an error, never a silent replacement`, async (t) => {
    const { sys, calls, cleanup } = fakeSystem({ tls: false });
    t.after(cleanup);
    prepare(sys.paths.tlsDir);
    const before = fs.readFileSync(path.join(sys.paths.tlsDir, "cert.pem"));

    await assert.rejects(ensureCertificate(sys), { code: "TLS_UNAVAILABLE" });
    assert.throws(() => loadTls(sys), { code: "TLS_UNAVAILABLE" });

    assert.equal(opensslCalls(calls).length, 0);
    assert.deepEqual(
      fs.readFileSync(path.join(sys.paths.tlsDir, "cert.pem")),
      before,
    );
  });
}

test("a failed openssl run leaves no certificate directory", async (t) => {
  const { sys, cleanup } = fakeSystem({
    tls: false,
    failOn: (command) => command === "openssl",
  });
  t.after(cleanup);
  await assert.rejects(ensureCertificate(sys), /openssl failed/);
  assert.deepEqual(fs.readdirSync(sys.paths.etcDir), []);
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

test(
  "the real openssl command makes the certificate the contract names",
  { skip: !hasOpenssl && "openssl is not installed" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-tls-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sys = createSystem({
      paths: {
        etcDir: path.join(root, "etc"),
        tlsDir: path.join(root, "etc/tls"),
      },
    });

    assert.equal(await ensureCertificate(sys), "created");

    const { key, cert } = loadTls(sys);
    const certificate = new X509Certificate(cert);
    const privateKey = createPrivateKey(key);
    assert.equal(privateKey.asymmetricKeyDetails.namedCurve, "prime256v1");
    assert.ok(certificate.checkPrivateKey(privateKey));
    assert.equal(certificate.subjectAltName, "DNS:devchain-host");
    const days =
      (Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) /
      86_400_000;
    assert.equal(days, 3650);
    assert.equal(mode(path.join(sys.paths.tlsDir, "key.pem")), 0o600);
  },
);

test("devchain-bootstrap.service creates the certificate before systemctl start returns", () => {
  const unit = fs.readFileSync(
    path.join(__dirname, "../systemd/devchain-bootstrap.service"),
    "utf8",
  );
  const pre = unit.indexOf(
    "\nExecStartPre=/usr/local/bin/devchain-bootstrap --ensure-certificate\n",
  );
  assert.ok(pre > 0);
  assert.ok(
    pre < unit.indexOf("\nExecStart=/usr/local/bin/devchain-bootstrap\n"),
  );
});
