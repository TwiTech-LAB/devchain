const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} = require("node:fs");
const { builtinModules } = require("node:module");
const { tmpdir } = require("node:os");
const { join, relative } = require("node:path");

const repoRoot = join(__dirname, "..");
// Test support compiled into dist/server; never loaded at runtime.
const TEST_SUPPORT =
  /(^|\/)(test-setup\.js$|test\/|__fixtures__\/|__test-utils__\/)/;

// Every bare require() in the packed dist must resolve from a declared dependency
// or a package copied into dist/node_modules; a local-app-only dependency would
// otherwise fail with MODULE_NOT_FOUND after a global install.
function findUndeclaredRequires(packageRoot) {
  const declared = new Set(
    Object.keys(
      JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
        .dependencies,
    ),
  );
  const distRoot = join(packageRoot, "dist");
  const undeclared = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(distRoot, path);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
        continue;
      }
      if (!entry.name.endsWith(".js") || TEST_SUPPORT.test(rel)) continue;
      const source = readFileSync(path, "utf8");
      for (const [, spec] of source.matchAll(
        /\brequire\(\s*["']([^"'./][^"']*)["']\s*\)/g,
      )) {
        const parts = spec.split("/");
        const name = spec.startsWith("@")
          ? parts.slice(0, 2).join("/")
          : parts[0];
        if (
          spec.startsWith("node:") ||
          builtinModules.includes(name) ||
          declared.has(name) ||
          existsSync(join(distRoot, "node_modules", name))
        ) {
          continue;
        }
        if (!undeclared.has(name)) undeclared.set(name, rel);
      }
    }
  };
  walk(distRoot);
  return [...undeclared].map(([name, file]) => `${name} (dist/${file})`);
}

function verifyHostInstall(packageRoot) {
  const hostInstallDir = join(packageRoot, "dist", "host-install");
  const requiredFiles = [
    "devchain-host-bootstrap.tgz",
    "devchain-bootstrap.service",
    "60-devchain-inotify.conf",
    "devchain-no-session-bus.pref",
    "pins.json",
  ];
  for (const file of requiredFiles) {
    assert.ok(
      existsSync(join(hostInstallDir, file)),
      `packed CLI is missing dist/host-install/${file}`,
    );
  }

  const archive = join(hostInstallDir, "devchain-host-bootstrap.tgz");
  const entries = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
  }).split(/\r?\n/);
  assert.ok(
    entries.includes("package/bin/devchain-bootstrap.js"),
    "host bootstrap tarball is missing package/bin/devchain-bootstrap.js",
  );

  const pins = JSON.parse(
    readFileSync(join(hostInstallDir, "pins.json"), "utf8"),
  );
  assert.equal(
    typeof pins.nodeVersion,
    "string",
    "pins.json is missing nodeVersion",
  );
  assert.equal(
    typeof pins.syncthingVersion,
    "string",
    "pins.json is missing syncthingVersion",
  );
  assert.equal(
    typeof pins.npmRegistry,
    "string",
    "pins.json is missing npmRegistry",
  );
  assert.ok(
    Array.isArray(pins.aptPackages),
    "pins.json is missing aptPackages",
  );
  assert.ok(pins.aptPackages.length > 0, "pins.json aptPackages is empty");
  assert.equal(typeof pins.bootstrap?.package, "string");
  assert.equal(typeof pins.bootstrap?.version, "string");

  const actualSha256 = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  assert.equal(
    pins.bootstrap?.sha256,
    actualSha256,
    "pins.json bootstrap SHA-256 does not match devchain-host-bootstrap.tgz",
  );

  const bootstrapManifest = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(pins.bootstrap.package, bootstrapManifest.name);
  assert.equal(pins.bootstrap.version, bootstrapManifest.version);
}

const tempRoot = mkdtempSync(join(tmpdir(), "devchain-cli-pack-"));

try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", tempRoot],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    ),
  );
  const archive = join(tempRoot, packed[0].filename);
  const isolated = join(tempRoot, "isolated");
  mkdirSync(isolated);
  execFileSync("tar", ["-xzf", archive, "-C", isolated]);

  const packageRoot = join(isolated, "package");
  verifyHostInstall(packageRoot);

  // An npm prefix such as ~/src/npm-global must not stop the packed server from
  // finding its own dist/host-install inputs; the lookup may not key on /src/.
  const srcPrefixRoot = join(
    tempRoot,
    "home/u/src/npm-global/lib/node_modules/devchain-cli",
  );
  cpSync(packageRoot, srcPrefixRoot, { recursive: true });
  // The tarball ships without dependencies; a real install puts them beside the package.
  symlinkSync(
    join(repoRoot, "node_modules"),
    join(srcPrefixRoot, "node_modules"),
    "junction",
  );
  const srcPrefixModule = join(
    srcPrefixRoot,
    "dist/server/modules/remotes/host-install",
  );
  const { findHostInstallDist } = require(
    join(srcPrefixModule, "host-install.service.js"),
  );
  assert.equal(
    findHostInstallDist(srcPrefixModule),
    join(srcPrefixRoot, "dist/host-install"),
    "packed server cannot find its host-install inputs under an install path containing /src/",
  );

  const buildInfoFile = join(packageRoot, "dist", "build-info.json");
  assert.ok(
    existsSync(buildInfoFile),
    "packed CLI is missing dist/build-info.json",
  );
  // The packed reader is the validator the runtime uses; it returns null for a malformed stamp.
  const { readBuildInfo } = require(
    join(
      packageRoot,
      "dist",
      "server",
      "modules",
      "core",
      "controllers",
      "build-info.js",
    ),
  );
  const buildInfo = readBuildInfo();
  assert.ok(buildInfo !== null, "packed CLI dist/build-info.json is malformed");
  assert.deepEqual(buildInfo, JSON.parse(readFileSync(buildInfoFile, "utf8")));

  const pins = JSON.parse(
    readFileSync(join(packageRoot, "dist", "host-cli-pins.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(pins), [
    "claude",
    "codex",
    "copilot",
    "opencode",
    "agy",
  ]);
  assert.deepEqual(
    findUndeclaredRequires(packageRoot),
    [],
    "packed CLI requires packages missing from root package.json dependencies",
  );

  const runtimeEntry = join(packageRoot, "dist", "server", "main.js");
  const check = `
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const { realpathSync } = require('node:fs');
    const r = createRequire(process.argv[1]);
    const resolved = realpathSync(r.resolve('@devchain/proxmox-client'));
    const expected = realpathSync(process.argv[2]);
    assert.equal(resolved, expected);
    assert.equal(typeof r('@devchain/proxmox-client').ProxmoxClient, 'function');
    process.stdout.write(resolved + '\\n');
  `;
  const expectedEntry = join(
    packageRoot,
    "dist",
    "node_modules",
    "@devchain",
    "proxmox-client",
    "dist",
    "index.js",
  );
  const output = execFileSync(
    process.execPath,
    ["-e", check, runtimeEntry, expectedEntry],
    {
      cwd: isolated,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    },
  ).trim();
  assert.equal(output, expectedEntry);
  process.stdout.write(
    `Packed CLI resolves @devchain/proxmox-client: ${output}\n`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
