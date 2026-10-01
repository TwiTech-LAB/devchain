"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { jobStatus, requireClaim, writeFileAtomic } = require("./claim");
const { BootstrapError } = require("./validate");
const { installedPackages, runWhenUnlocked } = require("./packages");

const { randomUUID } = require("node:crypto");

const UNIT = "devchain-host-docker";
const PACKAGES = [
  "docker-ce",
  "docker-ce-cli",
  "containerd.io",
  "docker-buildx-plugin",
  "docker-compose-plugin",
];
const CONFLICTS = [
  "docker.io",
  "containerd",
  "runc",
  "docker-compose",
  "docker-compose-v2",
  "docker-doc",
  "docker-buildx",
  "podman-docker",
];

const status = (sys) => jobStatus(sys, "docker.json");
const writeStatus = (sys, value) => status(sys).write(value);
const readDockerStatus = (sys) => status(sys).read();

async function requestDocker(sys) {
  requireClaim(sys);
  const jobId = randomUUID();
  try {
    await sys.run(
      "systemd-run",
      [
        `--unit=${UNIT}`,
        "--collect",
        "--no-block",
        "--quiet",
        path.join(sys.paths.binDir, "devchain-host-update"),
        "--docker",
        "--run",
        jobId,
      ],
      { timeoutMs: 10_000 },
    );
  } catch {
    const { stdout } = await sys.run(
      "systemctl",
      ["show", `${UNIT}.service`, "--property=ActiveState", "--value"],
      { timeoutMs: 5_000 },
    );
    if (["active", "activating"].includes(stdout.trim())) {
      const status = readDockerStatus(sys);
      return {
        jobId: ["installing", "restarting"].includes(status?.state)
          ? status.jobId
          : null,
      };
    }
    throw new BootstrapError(
      409,
      "DOCKER_START_FAILED",
      "Could not start the Docker install; retry.",
    );
  }
  // Only the detached worker writes status: the request can return after the worker finishes.
  return { jobId };
}

async function usable(sys) {
  try {
    const engine = await sys.run("docker", [
      "--host=unix:///var/run/docker.sock",
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    const compose = await sys.run("docker", ["compose", "version", "--short"]);
    return Boolean(engine.stdout.trim() && compose.stdout.trim());
  } catch {
    return false;
  }
}

async function install(sys) {
  // A working Engine and Compose from any source (Ubuntu's docker.io with
  // docker-compose-v2 is common) needs no install; only a missing Docker
  // makes distro packages a conflict for Docker's own repository.
  if (await usable(sys)) return;
  const installed = await installedPackages(sys);
  const conflicts = CONFLICTS.filter((name) => installed.has(name));
  if (conflicts.length)
    throw new BootstrapError(
      409,
      "DOCKER_PACKAGE_CONFLICT",
      `Conflicting packages: ${conflicts.join(", ")}. Resolve them manually before retrying; no packages were replaced.`,
    );
  const release = Object.fromEntries(
    fs
      .readFileSync(sys.paths.osReleaseFile, "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        return [
          line.slice(0, index),
          line.slice(index + 1).replace(/^["']|["']$/g, ""),
        ];
      }),
  );
  const distro = release.ID;
  const codename = release.UBUNTU_CODENAME || release.VERSION_CODENAME;
  if (
    !["ubuntu", "debian"].includes(distro) ||
    !/^[a-z][a-z0-9-]*$/.test(codename || "")
  )
    throw new BootstrapError(
      400,
      "DOCKER_OS_UNSUPPORTED",
      "Docker installation requires Ubuntu or Debian with a release codename.",
    );
  const architecture = (
    await sys.run("dpkg", ["--print-architecture"])
  ).stdout.trim();
  if (!/^[a-z0-9]+$/.test(architecture))
    throw new Error("Invalid Debian architecture.");
  const key = path.join(sys.paths.aptDir, "keyrings/docker.asc");
  const source = path.join(sys.paths.aptDir, "sources.list.d/docker.sources");
  fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o755 });
  const response = await sys.fetch(
    `https://download.docker.com/linux/${distro}/gpg`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok)
    throw new Error("Could not download the Docker repository key.");
  const publicKey = await response.text();
  if (
    !publicKey.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") ||
    publicKey.length > 100_000
  )
    throw new Error("Invalid Docker repository key.");
  writeFileAtomic(key, publicKey, 0o644, null, sys);
  writeFileAtomic(
    source,
    `Types: deb\nURIs: https://download.docker.com/linux/${distro}\nSuites: ${codename}\nComponents: stable\nArchitectures: ${architecture}\nSigned-By: ${key}\n`,
    0o644,
    null,
    sys,
  );
  const options = {
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive", LC_ALL: "C" },
    timeoutMs: 20 * 60_000,
  };
  await runWhenUnlocked(sys, "dpkg", "dpkg", ["--configure", "-a"], options);
  const apt = ["-o", "DPkg::Lock::Timeout=600"];
  await runWhenUnlocked(
    sys,
    "apt lists",
    "apt-get",
    [...apt, "update"],
    options,
  );
  await runWhenUnlocked(
    sys,
    "apt",
    "apt-get",
    [
      ...apt,
      "install",
      "-y",
      "--no-install-recommends",
      "--no-remove",
      ...PACKAGES,
    ],
    options,
  );
  await sys.run("systemctl", ["enable", "--now", "docker.service"]);
  if (!(await usable(sys)))
    throw new Error("Docker Engine and Compose did not become available.");
}

async function runDocker(sys, jobId = randomUUID()) {
  const claim = requireClaim(sys);
  try {
    writeStatus(sys, { jobId, state: "installing" });
    await install(sys);
    await sys.run("usermod", ["-aG", "docker", claim.userName]);
    writeStatus(sys, { jobId, state: "restarting" });
    await sys.run("systemctl", ["restart", "devchain-host.service"], {
      timeoutMs: 120_000,
    });
    writeStatus(sys, { jobId, state: "done" });
  } catch (error) {
    writeStatus(sys, {
      jobId,
      state: "failed",
      code: error.code || "DOCKER_INSTALL_FAILED",
      error: error.message,
    });
    throw error;
  }
}

module.exports = { requestDocker, runDocker, readDockerStatus };
