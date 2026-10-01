const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  cpSync,
  mkdirSync,
  existsSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  statSync,
} = require("fs");
const { join } = require("path");
const { tmpdir } = require("node:os");

function requiredPath(repoRoot, relativePath, kind = "file") {
  const path = join(repoRoot, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing required host-install input: ${relativePath}`);
  }

  const stats = statSync(path);
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(
      `Invalid host-install input: ${relativePath} must be a ${kind}`,
    );
  }

  return path;
}

function parseVersionsEnv(path) {
  const values = {};
  for (const [index, rawLine] of readFileSync(path, "utf8")
    .split(/\r?\n/)
    .entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(
        `Invalid assignment in apps/host-image/versions.env at line ${index + 1}`,
      );
    }
    values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }

  const required = ["NODE_VERSION", "SYNCTHING_VERSION", "NPM_REGISTRY"];
  for (const name of required) {
    if (!values[name]) {
      throw new Error(
        `apps/host-image/versions.env must define ${name} for the host installer`,
      );
    }
  }
  return values;
}

function parseAptPackages(path) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const first = lines.findIndex((line) =>
    /^\s*apt-get\s+install\s+-y\s+--no-install-recommends(?:\s|\\|$)/.test(
      line,
    ),
  );
  if (first === -1) {
    throw new Error(
      "apps/host-image/customize.sh is missing its apt-get install -y --no-install-recommends package list",
    );
  }

  const packages = [];
  let complete = false;
  for (let index = first; index < lines.length; index += 1) {
    let line = lines[index].replace(/\s+#.*$/, "").trim();
    const continued = line.endsWith("\\");
    if (continued) line = line.slice(0, -1).trim();
    if (index === first) {
      line = line
        .replace(/^apt-get\s+install\s+-y\s+--no-install-recommends/, "")
        .trim();
    }
    packages.push(
      ...line.split(/\s+/).filter((name) => name && !name.startsWith("-")),
    );
    if (!continued) {
      complete = true;
      break;
    }
  }

  if (!complete || packages.length === 0) {
    throw new Error(
      "Unable to read the apt package list from apps/host-image/customize.sh",
    );
  }
  return packages;
}

function copyHostInstallInputs(repoRoot, destDir) {
  const hostInstallDir = join(destDir, "host-install");
  rmSync(hostInstallDir, { recursive: true, force: true });

  const bootstrapDir = requiredPath(
    repoRoot,
    "apps/host-bootstrap",
    "directory",
  );
  const bootstrapManifestPath = requiredPath(
    repoRoot,
    "apps/host-bootstrap/package.json",
  );
  const unitPath = requiredPath(
    repoRoot,
    "apps/host-bootstrap/systemd/devchain-bootstrap.service",
  );
  const versionsPath = requiredPath(repoRoot, "apps/host-image/versions.env");
  const customizePath = requiredPath(repoRoot, "apps/host-image/customize.sh");
  const inotifyPath = requiredPath(
    repoRoot,
    "apps/host-image/files/60-devchain-inotify.conf",
  );
  const aptPreferencePath = requiredPath(
    repoRoot,
    "apps/host-image/files/devchain-no-session-bus.pref",
  );

  const bootstrapManifest = JSON.parse(
    readFileSync(bootstrapManifestPath, "utf8"),
  );
  if (!bootstrapManifest.name || !bootstrapManifest.version) {
    throw new Error(
      "apps/host-bootstrap/package.json must define the package name and version",
    );
  }
  const versions = parseVersionsEnv(versionsPath);
  const aptPackages = parseAptPackages(customizePath);
  const tempPackDir = mkdtempSync(join(tmpdir(), "devchain-host-bootstrap-"));

  try {
    let packed;
    try {
      packed = JSON.parse(
        execFileSync(
          "npm",
          [
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            tempPackDir,
          ],
          { cwd: bootstrapDir, encoding: "utf8" },
        ),
      );
    } catch (error) {
      const detail = (error.stderr || error.message || "").toString().trim();
      throw new Error(
        `Failed to pack required host bootstrap package from apps/host-bootstrap: ${detail}`,
      );
    }

    if (!Array.isArray(packed) || !packed[0]?.filename) {
      throw new Error(
        "npm pack did not produce a tarball for apps/host-bootstrap",
      );
    }
    const packedArchive = join(tempPackDir, packed[0].filename);
    if (!existsSync(packedArchive)) {
      throw new Error(
        "npm pack reported success but apps/host-bootstrap tarball is missing",
      );
    }

    const archiveBytes = readFileSync(packedArchive);
    const bootstrapSha256 = createHash("sha256")
      .update(archiveBytes)
      .digest("hex");
    const pins = {
      nodeVersion: versions.NODE_VERSION,
      syncthingVersion: versions.SYNCTHING_VERSION,
      npmRegistry: versions.NPM_REGISTRY,
      bootstrap: {
        package: bootstrapManifest.name,
        version: bootstrapManifest.version,
        sha256: bootstrapSha256,
      },
      aptPackages,
    };

    mkdirSync(hostInstallDir, { recursive: true });
    writeFileSync(
      join(hostInstallDir, "devchain-host-bootstrap.tgz"),
      archiveBytes,
    );
    writeFileSync(
      join(hostInstallDir, "pins.json"),
      `${JSON.stringify(pins, null, 2)}\n`,
    );
    cpSync(unitPath, join(hostInstallDir, "devchain-bootstrap.service"));
    cpSync(inotifyPath, join(hostInstallDir, "60-devchain-inotify.conf"));
    cpSync(
      aptPreferencePath,
      join(hostInstallDir, "devchain-no-session-bus.pref"),
    );
  } finally {
    rmSync(tempPackDir, { recursive: true, force: true });
  }
}

function createBuildInfo(repoRoot) {
  const builtAt = new Date().toISOString();
  const gitOptions = {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  };

  try {
    const commit = execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      gitOptions,
    ).trim();
    const status = execFileSync("git", ["status", "--porcelain"], gitOptions);
    return { commit, dirty: status.length > 0, builtAt };
  } catch {
    // Git metadata is optional for builds from source archives.
    return { commit: null, dirty: null, builtAt };
  }
}

function main() {
  const repoRoot = join(__dirname, "..");
  const src = join(__dirname, "cli.js");
  const destDir = join(repoRoot, "dist");
  const dest = join(destDir, "cli.js");
  const libSrcDir = join(__dirname, "lib");
  const libDestDir = join(destDir, "lib");

  // Ensure dest dir exists
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  copyHostInstallInputs(repoRoot, destDir);

  // Copy CLI file
  cpSync(src, dest);
  cpSync(
    join(__dirname, "host-cli-pins.json"),
    join(destDir, "host-cli-pins.json"),
  );
  writeFileSync(
    join(destDir, "build-info.json"),
    `${JSON.stringify(createBuildInfo(repoRoot), null, 2)}\n`,
  );

  // Make it executable
  chmodSync(dest, 0o755);

  // Copy CLI support library (e.g., interactive-cli)
  // Ensure the lib directory exists and copy recursively so runtime requires work from dist
  if (existsSync(libSrcDir)) {
    mkdirSync(libDestDir, { recursive: true });
    cpSync(libSrcDir, libDestDir, { recursive: true });
  }

  // eslint-disable-next-line no-console
  console.log(`Copied CLI to ${dest}`);
  if (existsSync(libDestDir)) {
    console.log(`Copied CLI lib to ${libDestDir}`);
  }
  console.log(`Copied host install inputs to ${join(destDir, "host-install")}`);
}

main();
