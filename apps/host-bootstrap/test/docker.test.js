"use strict";

// Fake commands and real temporary files exercise repository/status writes without root or networking.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fakeSystem } = require("./helpers");
const { requestDocker, runDocker, readDockerStatus } = require("../lib/docker");

function fixture(
  t,
  {
    distro = "ubuntu",
    packages = "",
    existing = false,
    failApt = false,
    lock = false,
  } = {},
) {
  const fake = fakeSystem();
  t.after(fake.cleanup);
  const { sys, root } = fake;
  sys.paths.aptDir = path.join(root, "apt");
  sys.paths.osReleaseFile = path.join(root, "os-release");
  fs.mkdirSync(sys.paths.etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(sys.paths.etcDir, "claim.json"),
    JSON.stringify({ userName: "alice", version: "1.0.0" }),
  );
  fs.writeFileSync(
    sys.paths.osReleaseFile,
    `ID=${distro}\nVERSION_CODENAME=${distro === "debian" ? "bookworm" : "noble"}\n`,
  );
  sys.fetch = async () => ({
    ok: true,
    text: async () => "-----BEGIN PGP PUBLIC KEY BLOCK-----\npublic fixture",
  });
  let ready = existing;
  let locked = lock;
  const run = sys.run;
  sys.sleep = async () => {};
  sys.run = async (command, args, options) => {
    const result = await run(command, args, options);
    if (command === "dpkg-query") return { stdout: packages };
    if (command === "dpkg" && args[0] === "--print-architecture")
      return { stdout: "amd64\n" };
    if (command === "docker") {
      if (!ready) throw new Error("missing Docker");
      return { stdout: "29.0.0\n" };
    }
    if (command === "apt-get") {
      if (failApt) throw new Error("apt download failed");
      if (locked) {
        locked = false;
        throw new Error("lock is held by another process");
      }
      if (args.includes("install")) ready = true;
    }
    return result;
  };
  return fake;
}

test("request detaches immediately and does not overwrite a worker status", async (t) => {
  const { sys, calls } = fixture(t);
  const { jobId } = await requestDocker(sys);
  assert.equal(typeof jobId, "string");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "systemd-run");
  assert.ok(calls[0].includes("--no-block"));
  assert.deepEqual(calls[0].slice(-3), ["--docker", "--run", jobId]);
  assert.equal(readDockerStatus(sys), null);
});

for (const distro of ["ubuntu", "debian"]) {
  test(`${distro} installs official packages, waits for locks, and restarts after adding group`, async (t) => {
    const { sys, calls } = fixture(t, { distro, lock: true });
    await runDocker(sys, "job");
    const source = fs.readFileSync(
      path.join(sys.paths.aptDir, "sources.list.d/docker.sources"),
      "utf8",
    );
    assert.match(source, new RegExp(`download.docker.com/linux/${distro}`));
    const apt = calls.find(
      (call) => call[0] === "apt-get" && call.includes("install"),
    );
    assert.ok(apt.includes("--no-remove"));
    for (const pkg of [
      "docker-ce",
      "docker-ce-cli",
      "containerd.io",
      "docker-buildx-plugin",
      "docker-compose-plugin",
    ])
      assert.ok(apt.includes(pkg));
    assert.equal(
      calls.filter((call) => call[0] === "apt-get" && call.includes("update"))
        .length,
      2,
    );
    assert.ok(
      calls.findIndex((call) => call[0] === "usermod") <
        calls.findIndex((call) => call.includes("restart")),
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "usermod"),
      ["usermod", "-aG", "docker", "alice"],
    );
    assert.equal(readDockerStatus(sys).state, "done");
    assert.equal(readDockerStatus(sys).jobId, "job");
  });
}

test("an existing usable Engine and Compose avoids apt", async (t) => {
  const { sys, calls } = fixture(t, { existing: true });
  await runDocker(sys);
  assert.ok(!calls.some((call) => call[0] === "apt-get"));
  assert.equal(readDockerStatus(sys).state, "done");
});

test("a usable distro docker.io only needs the group, not a conflict", async (t) => {
  const { sys, calls } = fixture(t, {
    existing: true,
    packages: "docker.io installed\ncontainerd installed\nrunc installed\n",
  });
  await runDocker(sys);
  assert.ok(!calls.some((call) => call[0] === "apt-get"));
  assert.deepEqual(
    calls.find((call) => call[0] === "usermod"),
    ["usermod", "-aG", "docker", "alice"],
  );
  assert.equal(readDockerStatus(sys).state, "done");
});

for (const pkg of ["docker.io", "containerd", "runc"]) {
  test(`${pkg} without a usable Docker is a conflict and is never replaced`, async (t) => {
    const { sys, calls } = fixture(t, { packages: `${pkg} installed\n` });
    await assert.rejects(runDocker(sys), { code: "DOCKER_PACKAGE_CONFLICT" });
    assert.ok(
      !calls.some((call) =>
        ["apt-get", "usermod", "systemctl"].includes(call[0]),
      ),
    );
    assert.equal(readDockerStatus(sys).code, "DOCKER_PACKAGE_CONFLICT");
  });
}

test("apt failure records a retriable failure without restarting the host", async (t) => {
  const { sys, calls } = fixture(t, { failApt: true });
  await assert.rejects(runDocker(sys), /apt download failed/);
  assert.equal(readDockerStatus(sys).state, "failed");
  assert.ok(!calls.some((call) => call.includes("restart")));
  const run = sys.run;
  sys.run = (command, args, options) =>
    command === "apt-get"
      ? Promise.resolve({ stdout: "" })
      : command === "docker"
        ? Promise.resolve({ stdout: "29" })
        : run(command, args, options);
  await runDocker(sys);
  assert.equal(readDockerStatus(sys).state, "done");
});
