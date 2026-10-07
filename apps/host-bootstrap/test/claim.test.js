"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performClaim, readClaim, refreshHostUnit } = require("../lib/claim");
const { renderEnvFile } = require("../lib/render");
const {
  fakeSystem,
  fixtureTls,
  mode,
  pins,
  pinnedCliVersions,
  manifestOnlyDevchainCatalog,
  assertProviderClisInstalledFromPublicRegistry,
} = require("./helpers");

const cliVersions = pinnedCliVersions();

const silent = () => {};

function claimIn(root, over = {}) {
  const homePath = path.join(root, "Users/alice");
  return {
    userName: "alice",
    homePath,
    version: "0.24.0",
    port: 3100,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "token-1" },
    files: [
      {
        path: path.join(homePath, ".codex/auth.json"),
        mode: 0o600,
        content: Buffer.from('{"a":1}'),
      },
    ],
    ...over,
  };
}

test("a claim creates the user, private auth files, the service and the record", async (t) => {
  const { sys, root, calls, owners, cleanup } = fakeSystem();
  t.after(cleanup);
  const claim = claimIn(root);

  const record = await performClaim(claim, sys, silent);

  assert.deepEqual(record, {
    userName: "alice",
    homePath: claim.homePath,
    uid: 1001,
    gid: 1001,
    primaryGroup: "alice",
    version: "0.24.0",
    cliVersions,
    port: 3100,
    claimedAt: "2026-09-24T10:00:00.000Z",
  });
  assert.deepEqual(readClaim(sys), record);
  const profile = path.join(sys.paths.profileDir, "devchain-ids.sh");
  assert.equal(
    fs.readFileSync(profile, "utf8"),
    'export DEVCHAIN_UID="$(id -u)" DEVCHAIN_GID="$(id -g)"\n',
  );
  assert.equal(mode(profile), 0o644);
  assert.deepEqual(
    calls.find(([c]) => c === "useradd"),
    [
      "useradd",
      "-m",
      "-d",
      claim.homePath,
      "-s",
      "/bin/bash",
      "-g",
      "1001",
      "alice",
    ],
  );
  assert.deepEqual(
    calls.find(([c]) => c === "npm"),
    [
      "npm",
      "install",
      "-g",
      "--no-fund",
      "--no-audit",
      `--prefix=${sys.paths.installRoot}/versions/0.24.0`,
      "--registry=https://registry.example/",
      "devchain-cli@0.24.0",
    ],
  );
  const bin = path.join(sys.paths.binDir, "devchain");
  assert.equal(
    fs.readlinkSync(bin),
    path.join(sys.paths.installRoot, "current/bin/devchain"),
  );
  assert.equal(fs.readFileSync(bin, "utf8"), "0.24.0");

  const envFile = path.join(claim.homePath, ".devchain/host.env");
  const userKey = path.join(claim.homePath, ".devchain/tls/key.pem");
  const userCert = path.join(claim.homePath, ".devchain/tls/cert.pem");
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    renderEnvFile({
      ...claim.env,
      DEVCHAIN_HOST_TLS_KEY_FILE: userKey,
      DEVCHAIN_HOST_TLS_CERT_FILE: userCert,
    }),
  );
  assert.deepEqual(fs.readFileSync(userKey), fixtureTls.key);
  assert.deepEqual(fs.readFileSync(userCert), fixtureTls.cert);
  for (const file of [userKey, userCert]) {
    assert.equal(mode(file), 0o600);
    // Owned before the rename that puts the file in place.
    assert.equal(owners.get(`${file}.tmp-${process.pid}`), "1001:1001");
  }
  assert.equal(mode(path.join(claim.homePath, ".devchain/tls")), 0o700);
  assert.equal(
    owners.get(path.join(claim.homePath, ".devchain/tls")),
    "1001:1001",
  );
  const authFile = path.join(claim.homePath, ".codex/auth.json");
  assert.equal(fs.readFileSync(authFile, "utf8"), '{"a":1}');
  for (const file of [envFile, authFile]) assert.equal(mode(file), 0o600);
  for (const dir of [".devchain", ".codex"]) {
    assert.equal(mode(path.join(claim.homePath, dir)), 0o700);
    assert.equal(owners.get(path.join(claim.homePath, dir)), "1001:1001");
  }
  assert.ok(
    !fs.existsSync(path.join(claim.homePath, ".claude/.credentials.json")),
  );

  const sudoers = fs.readFileSync(
    path.join(sys.paths.sudoersDir, "devchain-host"),
    "utf8",
  );
  assert.match(sudoers, /^alice ALL=\(ALL\) NOPASSWD:ALL$/m);
  assert.ok(
    sudoers.includes(
      `alice ALL=(root) NOPASSWD: ${sys.paths.binDir}/devchain-host-project-chown\n`,
    ),
  );
  assert.ok(
    sudoers.includes(
      `devchain-host-update, ${sys.paths.binDir}/devchain-host-project-root\n`,
    ),
  );
  assert.equal(mode(path.join(sys.paths.sudoersDir, "devchain-host")), 0o440);

  const unit = fs.readFileSync(
    path.join(sys.paths.systemdDir, "devchain-host.service"),
    "utf8",
  );
  assert.match(unit, /^User=alice$/m);
  assert.match(
    unit,
    new RegExp(
      `^EnvironmentFile=${claim.homePath}/\\.devchain/host\\.env$`,
      "m",
    ),
  );
  assert.ok(
    unit.includes(
      `\nExecStart=${sys.paths.binDir}/devchain start --foreground --host 0.0.0.0 --port 3100 --no-open\n`,
    ),
  );
  assert.match(unit, /^Conflicts=devchain-bootstrap\.service$/m);
  assert.match(unit, /^OOMPolicy=continue$/m);
  assert.match(unit, /on a version-changing update/);
  assert.doesNotMatch(unit, /^PAMName=/m);
  assert.doesNotMatch(unit, /@[A-Z]+@/);
  assertUnitPassesTls(unit, claim.homePath);
});

function assertUnitPassesTls(unit, homePath) {
  assert.ok(
    unit.includes(
      `\nEnvironment=DEVCHAIN_HOST_TLS_KEY_FILE=${homePath}/.devchain/tls/key.pem\n`,
    ),
  );
  assert.ok(
    unit.includes(
      `\nEnvironment=DEVCHAIN_HOST_TLS_CERT_FILE=${homePath}/.devchain/tls/cert.pem\n`,
    ),
  );
  assert.match(
    unit,
    /^ExecStartPre=\/bin\/sh -c .*DEVCHAIN_HOST_TLS_KEY_FILE/m,
  );
}

/**
 * Runs the unit's ExecStartPre as systemd would: `$$` is a literal `$`, and
 * the command sees the unit's environment.
 */
function runTlsPrecheck(unit, env) {
  const line = unit.match(/^ExecStartPre=\/bin\/sh -c '(.*)'$/m)[1];
  return spawnSync("/bin/sh", ["-c", line.replaceAll("$$", "$")], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

test("devchain-host.service refuses to start without a readable TLS key and certificate", async (t) => {
  const { sys, root, cleanup } = fakeSystem();
  t.after(cleanup);
  const claim = claimIn(root);
  await performClaim(claim, sys, silent);
  const unit = fs.readFileSync(
    path.join(sys.paths.systemdDir, "devchain-host.service"),
    "utf8",
  );
  const env = {
    DEVCHAIN_HOST_TLS_KEY_FILE: path.join(
      claim.homePath,
      ".devchain/tls/key.pem",
    ),
    DEVCHAIN_HOST_TLS_CERT_FILE: path.join(
      claim.homePath,
      ".devchain/tls/cert.pem",
    ),
  };
  assert.equal(runTlsPrecheck(unit, env).status, 0);

  const unset = runTlsPrecheck(unit, {
    ...env,
    DEVCHAIN_HOST_TLS_CERT_FILE: "",
  });
  assert.equal(unset.status, 1);
  assert.match(unset.stderr, /TLS file {2}is missing or unreadable/);

  fs.rmSync(env.DEVCHAIN_HOST_TLS_KEY_FILE);
  const missing = runTlsPrecheck(unit, env);
  assert.equal(missing.status, 1);
  assert.match(
    missing.stderr,
    new RegExp(`TLS file ${env.DEVCHAIN_HOST_TLS_KEY_FILE} is missing`),
  );
});

test("a claim without the VM certificate fails at the tls step and records nothing", async (t) => {
  const { sys, root, calls, cleanup } = fakeSystem({ tls: false });
  t.after(cleanup);
  await assert.rejects(performClaim(claimIn(root), sys, silent), (error) => {
    assert.equal(error.step, "tls");
    assert.match(error.message, /has no certificate/);
    return true;
  });
  assert.equal(readClaim(sys), null);
  assert.ok(!fs.existsSync(sys.paths.tlsDir));
  assert.ok(
    !calls.some(([command]) => command === "openssl" || command === "npm"),
  );
});

test("the claim record holds no credentials", async (t) => {
  const { sys, root, cleanup } = fakeSystem();
  t.after(cleanup);
  await performClaim(claimIn(root), sys, silent);
  const raw = fs.readFileSync(
    path.join(sys.paths.etcDir, "claim.json"),
    "utf8",
  );
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
    "claimedAt",
    "cliVersions",
    "gid",
    "homePath",
    "port",
    "primaryGroup",
    "uid",
    "userName",
    "version",
  ]);
  assert.doesNotMatch(raw, /token-1/);
});

test("a claim installs all five CLIs between DevChain install and activation", async (t) => {
  const { sys, root, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  const steps = [];
  await performClaim(claimIn(root), sys, (_level, _message, details) =>
    steps.push(details.step),
  );
  assert.deepEqual(steps, [
    "user",
    "sudoers",
    "profile",
    "tls",
    "provider-auth",
    "install",
    "helper",
    "clis",
    "activate",
    "service",
    "record",
  ]);
  const installs = calls.filter(
    ([command, action]) => command === "npm" && action === "install",
  );
  assert.deepEqual(
    installs.map((call) => call.at(-1)),
    [
      "devchain-cli@0.24.0",
      path.join(
        sys.paths.installRoot,
        "versions/0.24.0/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz",
      ),
      `@anthropic-ai/claude-code@${pins.claude.version}`,
      `@openai/codex@${pins.codex.version}`,
      `@github/copilot@${pins.copilot.version}`,
      `opencode-ai@${pins.opencode.version}`,
    ],
  );
  for (const call of installs.slice(2)) {
    assert.ok(call.includes(`--prefix=${sys.paths.cliPrefix}`));
    assert.ok(call.includes("--registry=https://registry.npmjs.org/"));
  }
  assert.ok(calls.some(([command]) => command === "curl"));
  assert.ok(calls.some(([command]) => command === "bash"));
  assert.deepEqual(readClaim(sys).cliVersions, cliVersions);
});

test("a claim succeeds when the manifest registry serves only devchain-cli", async (t) => {
  const { sys, root, callDetails, cleanup } = fakeSystem({
    registryCatalog: manifestOnlyDevchainCatalog,
  });
  t.after(cleanup);

  const record = await performClaim(claimIn(root), sys, silent);

  assert.deepEqual(record.cliVersions, cliVersions);
  assertProviderClisInstalledFromPublicRegistry(callDetails);
});

test("a retry skips provider CLIs already installed at the pins", async (t) => {
  let failService = true;
  const { sys, root, calls, cleanup } = fakeSystem({
    failOn: (command, args) =>
      failService && command === "systemctl" && args[0] === "daemon-reload",
  });
  t.after(cleanup);
  await assert.rejects(performClaim(claimIn(root), sys, silent), {
    step: "service",
  });
  assert.equal(readClaim(sys), null);
  failService = false;
  await performClaim(claimIn(root), sys, silent);
  assert.equal(calls.filter(([command]) => command === "npm").length, 8);
  assert.equal(calls.filter(([command]) => command === "curl").length, 2);
  assert.deepEqual(readClaim(sys).cliVersions, cliVersions);
});

test("refreshHostUnit re-writes a deleted unit from the claim record and the current template", async (t) => {
  const { sys, root, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  await performClaim(claimIn(root), sys, silent);
  fs.rmSync(path.join(sys.paths.systemdDir, "devchain-host.service"));

  assert.equal(await refreshHostUnit(sys), true);

  const unit = fs.readFileSync(
    path.join(sys.paths.systemdDir, "devchain-host.service"),
    "utf8",
  );
  assert.match(unit, /^User=alice$/m);
  assert.match(unit, /^OOMPolicy=continue$/m);
  assert.match(unit, /on a version-changing update/);
  assert.doesNotMatch(unit, /@[A-Z]+@/);
  assertUnitPassesTls(unit, path.join(root, "Users/alice"));
  assert.ok(
    calls.some(
      (call) => call[0] === "systemctl" && call[1] === "daemon-reload",
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "systemctl" &&
        call[1] === "enable" &&
        call[2] === "devchain-host.service",
    ),
  );
});

test("refreshHostUnit writes nothing while no claim record exists", async (t) => {
  const { sys, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  assert.equal(await refreshHostUnit(sys), false);
  assert.ok(
    !fs.existsSync(path.join(sys.paths.systemdDir, "devchain-host.service")),
  );
  assert.ok(!calls.some(([command]) => command === "systemctl"));
});

test("a retry after the failed service step leaves the unit write to the claim", async (t) => {
  let failService = true;
  const { sys, root, calls, cleanup } = fakeSystem({
    failOn: (command, args) =>
      failService && command === "systemctl" && args[0] === "daemon-reload",
  });
  t.after(cleanup);
  await assert.rejects(performClaim(claimIn(root), sys, silent), {
    step: "service",
  });
  assert.equal(readClaim(sys), null);

  assert.equal(await refreshHostUnit(sys), false);
  assert.ok(
    !calls.some((call) => call[0] === "systemctl" && call[1] === "enable"),
  );
});

test("a provider CLI failure names the CLI and leaves the claim unrecorded", async (t) => {
  const { sys, root, cleanup } = fakeSystem({
    failOn: (command, args) =>
      command === "npm" && args.at(-1)?.startsWith("@openai/codex@"),
  });
  t.after(cleanup);
  await assert.rejects(performClaim(claimIn(root), sys, silent), (error) => {
    assert.equal(error.step, "clis");
    assert.match(error.message, /CLI codex failed/);
    return true;
  });
  assert.equal(readClaim(sys), null);
  assert.ok(!fs.existsSync(path.join(sys.paths.binDir, "devchain")));
});

test("a DevChain package without pins fails before activation", async (t) => {
  const { sys, root, cleanup } = fakeSystem({ missingPins: true });
  t.after(cleanup);
  await assert.rejects(performClaim(claimIn(root), sys, silent), (error) => {
    assert.equal(error.step, "clis");
    assert.match(error.message, /missing dist\/host-cli-pins\.json/);
    return true;
  });
  assert.equal(readClaim(sys), null);
  assert.ok(!fs.existsSync(path.join(sys.paths.binDir, "devchain")));
});

test("a second claim is refused", async (t) => {
  const { sys, root, cleanup } = fakeSystem();
  t.after(cleanup);
  await performClaim(claimIn(root), sys, silent);
  await assert.rejects(performClaim(claimIn(root), sys, silent), {
    status: 409,
    code: "ALREADY_CLAIMED",
  });
});

test("a failed install leaves no record, and the retry reuses the created user", async (t) => {
  let failInstall = true;
  const { sys, root, calls, cleanup } = fakeSystem({
    failOn: (command) => command === "npm" && failInstall,
  });
  t.after(cleanup);

  await assert.rejects(performClaim(claimIn(root), sys, silent), (error) => {
    assert.equal(error.code, "CLAIM_STEP_FAILED");
    assert.equal(error.step, "install");
    return true;
  });
  assert.equal(readClaim(sys), null);

  failInstall = false;
  await performClaim(claimIn(root), sys, silent);
  assert.equal(calls.filter(([c]) => c === "useradd").length, 1);
  assert.equal(readClaim(sys).version, "0.24.0");
});

// Command-boundary tests exercise allocation and retries without modifying host accounts.
for (const uid of [1000, 501]) {
  test(`a free uid ${uid} is used with its requested primary gid`, async (t) => {
    const { sys, root, calls, accounts, owners, cleanup } = fakeSystem();
    t.after(cleanup);
    const claim = claimIn(root, { uid, gid: uid });
    const record = await performClaim(claim, sys, silent);
    assert.deepEqual(
      calls.find(([c]) => c === "groupadd"),
      ["groupadd", "-g", String(uid), "alice"],
    );
    assert.deepEqual(
      calls.find(([c]) => c === "useradd"),
      [
        "useradd",
        "-m",
        "-d",
        claim.homePath,
        "-s",
        "/bin/bash",
        "-g",
        String(uid),
        "-u",
        String(uid),
        "alice",
      ],
    );
    assert.equal(accounts.get("alice").uid, uid);
    assert.equal(
      owners.get(path.join(claim.homePath, ".devchain")),
      `${uid}:${uid}`,
    );
    assert.deepEqual(
      { ...record, cliVersions: null, claimedAt: null },
      {
        userName: "alice",
        homePath: claim.homePath,
        requestedUid: uid,
        requestedGid: uid,
        uid,
        gid: uid,
        primaryGroup: "alice",
        version: "0.24.0",
        cliVersions: null,
        port: 3100,
        claimedAt: null,
      },
    );
  });
}

test("an existing gid becomes the primary group without creating another group", async (t) => {
  const { sys, root, calls, cleanup } = fakeSystem({
    groups: [{ name: "dialout", gid: 20 }],
  });
  t.after(cleanup);
  const record = await performClaim(
    claimIn(root, { uid: 501, gid: 20 }),
    sys,
    silent,
  );
  assert.equal(
    calls.some(([c]) => c === "groupadd"),
    false,
  );
  assert.equal(record.uid, 501);
  assert.equal(record.gid, 20);
  assert.equal(record.primaryGroup, "dialout");
  assert.equal(record.uidConflict, undefined);
  assert.match(
    fs.readFileSync(
      path.join(sys.paths.systemdDir, "devchain-host.service"),
      "utf8",
    ),
    /^Group=dialout$/m,
  );
});

test("a free gid uses a free alternative group name when the username is taken", async (t) => {
  const { sys, root, calls, cleanup } = fakeSystem({
    groups: [
      { name: "alice", gid: 2000 },
      { name: "alice-1", gid: 2001 },
    ],
  });
  t.after(cleanup);
  const record = await performClaim(
    claimIn(root, { uid: 1000, gid: 1000 }),
    sys,
    silent,
  );
  assert.deepEqual(
    calls.find(([c]) => c === "groupadd"),
    ["groupadd", "-g", "1000", "alice-2"],
  );
  assert.equal(record.primaryGroup, "alice-2");
  assert.equal(record.gid, 1000);
});

test("a taken uid falls back and records the account that holds it", async (t) => {
  const { sys, root, calls, cleanup } = fakeSystem({
    users: [{ name: "ubuntu", uid: 1000, gid: 1000, home: "/home/ubuntu" }],
  });
  t.after(cleanup);
  const record = await performClaim(
    claimIn(root, { uid: 1000, gid: 1000 }),
    sys,
    silent,
  );
  assert.equal(calls.find(([c]) => c === "useradd").includes("-u"), false);
  assert.equal(record.uid, 1001);
  assert.equal(record.gid, 1000);
  assert.deepEqual(record.uidConflict, {
    requestedUid: 1000,
    holder: "ubuntu",
  });
});

test("a uid above the claim range uses the next free uid", async (t) => {
  const { sys, root, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  const record = await performClaim(claimIn(root, { uid: 70000 }), sys, silent);
  assert.equal(calls.find(([c]) => c === "useradd").includes("-u"), false);
  assert.equal(record.uid, 1001);
});

for (const uid of [1005, 501]) {
  test(`a partial claim retries an account with requested uid ${uid}`, async (t) => {
    let failSudoers = true;
    const { sys, root, calls, cleanup } = fakeSystem({
      failOn: (c) => failSudoers && c === "visudo",
    });
    t.after(cleanup);
    const claim = claimIn(root, { uid, gid: 20 });
    await assert.rejects(performClaim(claim, sys, silent), { step: "sudoers" });
    failSudoers = false;
    const record = await performClaim(claim, sys, silent);
    assert.equal(calls.filter(([c]) => c === "useradd").length, 1);
    assert.equal(record.uid, uid);
    assert.equal(record.gid, 20);
    assert.equal(record.uidConflict, undefined);
  });
}

test("an existing account with different ids is reused without inventing a conflict holder", async (t) => {
  const { sys, root, accounts, cleanup } = fakeSystem();
  t.after(cleanup);
  const claim = claimIn(root, { uid: 1010, gid: 20 });
  fs.mkdirSync(claim.homePath, { recursive: true });
  accounts.set("alice", {
    name: "alice",
    uid: 1001,
    gid: 1001,
    home: claim.homePath,
  });
  const record = await performClaim(claim, sys, silent);
  assert.equal(record.uid, 1001);
  assert.equal(record.gid, 1001);
  assert.deepEqual(record.uidConflict, { requestedUid: 1010, holder: null });
});

test("a gid-only mismatch does not name the claimed account as a uid holder", async (t) => {
  const { sys, root, accounts, cleanup } = fakeSystem();
  t.after(cleanup);
  const claim = claimIn(root, { uid: 1000, gid: 20 });
  fs.mkdirSync(claim.homePath, { recursive: true });
  accounts.set("alice", {
    name: "alice",
    uid: 1000,
    gid: 1000,
    home: claim.homePath,
  });
  const record = await performClaim(claim, sys, silent);
  assert.deepEqual(record.uidConflict, { requestedUid: 1000, holder: null });
});

test("a retry resolves the current requested-uid holder again", async (t) => {
  let failSudoers = true;
  const { sys, root, accounts, cleanup } = fakeSystem({
    users: [{ name: "ubuntu", uid: 1000, gid: 1000, home: "/home/ubuntu" }],
    failOn: (c) => failSudoers && c === "visudo",
  });
  t.after(cleanup);
  const claim = claimIn(root, { uid: 1000, gid: 1000 });
  await assert.rejects(performClaim(claim, sys, silent), { step: "sudoers" });
  accounts.delete("ubuntu");
  accounts.set("holder-now", {
    name: "holder-now",
    uid: 1000,
    gid: 1000,
    home: "/home/holder-now",
  });
  failSudoers = false;
  const record = await performClaim(claim, sys, silent);
  assert.deepEqual(record.uidConflict, {
    requestedUid: 1000,
    holder: "holder-now",
  });
});

for (const [actualUid, requestedUid] of [
  [499, 499],
  [501, 502],
  [501, undefined],
]) {
  test(`an existing low account ${actualUid} is refused for requested uid ${requestedUid}`, async (t) => {
    const { sys, root, accounts, calls, cleanup } = fakeSystem();
    t.after(cleanup);
    const claim = claimIn(root, { uid: requestedUid });
    accounts.set("alice", {
      name: "alice",
      uid: actualUid,
      gid: actualUid,
      home: claim.homePath,
    });
    await assert.rejects(performClaim(claim, sys, silent), {
      code: "USER_EXISTS",
    });
    assert.equal(calls.length, 0);
  });
}

test("a uid-only claim still works without a gid", async (t) => {
  const { sys, root, cleanup } = fakeSystem();
  t.after(cleanup);
  const record = await performClaim(claimIn(root, { uid: 501 }), sys, silent);
  assert.equal(record.uid, 501);
  assert.equal(record.gid, 501);
  assert.equal(record.requestedGid, undefined);
});

test("an existing system account or a foreign home is refused", async (t) => {
  const { sys, root, cleanup } = fakeSystem({
    users: [{ name: "daemon", uid: 1, gid: 1, home: "/usr/sbin" }],
  });
  t.after(cleanup);
  await assert.rejects(
    performClaim(claimIn(root, { userName: "daemon" }), sys, silent),
    { code: "USER_EXISTS" },
  );
  const taken = claimIn(root, { userName: "carol" });
  fs.mkdirSync(taken.homePath, { recursive: true });
  await assert.rejects(performClaim(taken, sys, silent), {
    code: "HOME_EXISTS",
  });
});

test("a symlink in the home is not followed", async (t) => {
  const { sys, root, accounts, cleanup } = fakeSystem();
  t.after(cleanup);
  const claim = claimIn(root);
  fs.mkdirSync(claim.homePath, { recursive: true });
  fs.symlinkSync(root, path.join(claim.homePath, ".codex"));
  accounts.set("alice", {
    name: "alice",
    uid: 1001,
    gid: 1001,
    home: claim.homePath,
  });
  await assert.rejects(performClaim(claim, sys, silent), {
    code: "SYMLINK_REFUSED",
  });
});

test("the env file escapes quotes, backslashes and dollars", () => {
  assert.equal(
    renderEnvFile({ A: 'x"y\\z$HOME`id`' }).split("\n")[1],
    'A="x\\"y\\\\z\\$HOME\\`id\\`"',
  );
});

test("claim snapshots the template before refreshing the helper", async (t) => {
  const { sys, root, cleanup } = fakeSystem();
  t.after(cleanup);
  const original = fs.readFileSync(sys.paths.unitTemplate, "utf8");
  sys.paths.unitTemplate = path.join(root, "unit-template");
  fs.writeFileSync(sys.paths.unitTemplate, original);
  const run = sys.run;
  sys.run = async (command, args, options) => {
    if (command === "npm" && args.at(-1).endsWith(".tgz")) {
      fs.writeFileSync(sys.paths.unitTemplate, "incompatible new template");
    }
    if (args[0] === "--clis") assert.equal(options.timeoutMs, 45 * 60_000);
    return run(command, args, options);
  };
  await performClaim(claimIn(root), sys, silent);
  const rendered = fs.readFileSync(
    path.join(sys.paths.systemdDir, "devchain-host.service"),
    "utf8",
  );
  assert.match(rendered, /^User=alice$/m);
  assert.doesNotMatch(rendered, /incompatible/);
});

test("helper integrity failure stops claim before CLI installation or activation", async (t) => {
  const { sys, root, calls, cleanup } = fakeSystem();
  t.after(cleanup);
  await assert.rejects(
    performClaim(claimIn(root), sys, (_level, _message, { step }) => {
      if (step === "helper") {
        fs.writeFileSync(
          path.join(
            sys.paths.installRoot,
            "versions/0.24.0/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz",
          ),
          "damaged",
        );
      }
    }),
    (error) =>
      error.step === "helper" && /SHA-256 mismatch/.test(error.message),
  );
  assert.equal(readClaim(sys), null);
  assert.equal(
    calls.some(([, arg]) => arg === "--clis"),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(sys.paths.installRoot, "current")),
    false,
  );
});

test("claim reports the new helper's stderr failure", async (t) => {
  const { sys, root, cleanup } = fakeSystem();
  t.after(cleanup);
  const run = sys.run;
  sys.run = async (command, args, options) => {
    if (args[0] === "--clis")
      throw new Error(
        'helper failed: {"code":"PACKAGES_FAILED","message":"apt-get install failed"}',
      );
    return run(command, args, options);
  };
  await assert.rejects(
    performClaim(claimIn(root), sys, silent),
    (error) =>
      error.step === "clis" &&
      /PACKAGES_FAILED.*apt-get install failed/.test(error.message),
  );
  assert.equal(readClaim(sys), null);
  assert.equal(
    fs.existsSync(path.join(sys.paths.installRoot, "current")),
    false,
  );
});
