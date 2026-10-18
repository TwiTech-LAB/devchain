const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
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
const { readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { isAbsolute, join, relative, sep } = require("node:path");
const { promisify } = require("node:util");
const { validateShrinkwrap } = require("./npm-shrinkwrap.js");

const repoRoot = join(__dirname, "..");
const runFile = promisify(execFile);
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
  assert.ok(
    Array.isArray(pins.toolPackages),
    "pins.json is missing toolPackages",
  );
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

function isWithin(root, file) {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Compare the installed runtime tree to the packed lock, never npm's rewritten lock. */
async function verifyInstalledVersions(packageRoot, originalLock) {
  const root = await realpath(packageRoot);
  const counts = { checked: 0, omittedOptional: 0 };
  for (const [location, record] of Object.entries(originalLock.packages)) {
    if (location === "") continue;
    const file = join(root, location, "package.json");
    let actual;
    try {
      const resolved = await realpath(file);
      assert.ok(
        isWithin(root, resolved),
        `installed package escapes the extracted installation: ${location}`,
      );
      actual = JSON.parse(await readFile(resolved, "utf8"));
    } catch (error) {
      // npm can omit unsupported platforms and optional dependencies whose install failed.
      if (error.code === "ENOENT" && (record.optional || record.devOptional)) {
        counts.omittedOptional++;
        continue;
      }
      throw error;
    }
    assert.equal(
      actual.version,
      record.version,
      `installed version differs from the original packed lock: ${location}`,
    );
    counts.checked++;
  }
  return counts;
}

async function verifyInstalledRuntime(packageRoot, originalLock) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^npm_config_/i.test(name) &&
        !["NODE_OPTIONS", "DEVCHAIN_SKIP_POSTINSTALL"].includes(name),
    ),
  );
  env.NODE_PATH = "";
  const userConfig = join(packageRoot, ".verify-user.npmrc");
  const globalConfig = join(packageRoot, ".verify-global.npmrc");
  await Promise.all([writeFile(userConfig, ""), writeFile(globalConfig, "")]);
  process.stdout.write(
    `Installing the extracted packed CLI with npm install --omit=dev: ${packageRoot}\n`,
  );
  const npmVersion = (
    await runFile("npm", ["--version"], { env })
  ).stdout.trim();
  process.stdout.write(
    `Environment: ${process.platform} ${process.arch}, Node ${process.versions.node}, npm ${npmVersion}\n`,
  );
  try {
    const installed = await runFile(
      "npm",
      [
        "install",
        "--omit=dev",
        "--include=optional",
        "--ignore-scripts=false",
        "--foreground-scripts",
        "--global=false",
        "--workspaces=false",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org/",
        `--userconfig=${userConfig}`,
        `--globalconfig=${globalConfig}`,
      ],
      { cwd: packageRoot, env, maxBuffer: 16 * 1024 * 1024 },
    );
    process.stdout.write(installed.stdout);
    process.stderr.write(installed.stderr);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }

  const counts = await verifyInstalledVersions(packageRoot, originalLock);
  const runtimeEntry = join(packageRoot, "dist", "server", "main.js");
  const check = `
    const assert = require('node:assert/strict');
    const { realpathSync } = require('node:fs');
    const { createRequire } = require('node:module');
    const { join, relative, isAbsolute, sep } = require('node:path');
    const root = realpathSync(process.argv[1]);
    const r = createRequire(process.argv[2]);
    const isolatedResolve = (name) => {
      const resolved = realpathSync(r.resolve(name));
      const rel = relative(root, resolved);
      assert.ok(rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), name + ' resolves outside the extracted installation');
      return resolved;
    };
    assert.equal(isolatedResolve('@devchain/proxmox-client'), join(root, 'dist/node_modules/@devchain/proxmox-client/dist/index.js'));
    assert.equal(typeof r('@devchain/proxmox-client').ProxmoxClient, 'function');
    assert.equal(isolatedResolve('@devchain/shared'), join(root, 'dist/node_modules/@devchain/shared/index.js'));
    assert.equal(typeof r('@devchain/shared').ExportSchema.parse, 'function');
    isolatedResolve('better-sqlite3');
    const Database = r('better-sqlite3');
    const db = new Database(':memory:');
    try { assert.deepEqual(db.prepare('select 42 as value').get(), { value: 42 }); }
    finally { db.close(); }
    isolatedResolve('node-pty');
    assert.equal(typeof r('node-pty').spawn, 'function');
    process.stdout.write('Isolated dependency resolution, bundled workspace packages, SQLite query, and node-pty loading passed.\\n');
  `;
  const verified = await runFile(
    process.execPath,
    ["-e", check, packageRoot, runtimeEntry],
    { cwd: packageRoot, env },
  );
  process.stdout.write(verified.stdout);
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const cliVersion = (
    await runFile(
      process.execPath,
      [join(packageRoot, "dist", "cli.js"), "--version"],
      { cwd: packageRoot, env },
    )
  ).stdout.trim();
  assert.equal(
    cliVersion,
    manifest.version,
    "installed CLI version differs from its packed manifest",
  );
  process.stdout.write(
    `Lock-aware npm installation from an extracted package passed: CLI ${cliVersion}; ${counts.checked} runtime package versions match the original packed lock; ${counts.omittedOptional} optional packages omitted.\n`,
  );
}

async function verifyPackedRuntime({ install = false } = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), "devchain-cli-pack-"));

  try {
    if (install) {
      assert.ok(
        !isWithin(await realpath(repoRoot), await realpath(tempRoot)),
        "installation verification must use a temporary directory outside the repository",
      );
    }
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
    const originalLock = JSON.parse(
      readFileSync(join(packageRoot, "npm-shrinkwrap.json"), "utf8"),
    );
    validateShrinkwrap(
      JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      originalLock,
    );
    const runtimeEntry = join(packageRoot, "dist", "server", "main.js");
    assert.ok(
      existsSync(runtimeEntry),
      "packed CLI is missing dist/server/main.js; check the Local App build output layout",
    );
    verifyHostInstall(packageRoot);
    if (install) {
      await verifyInstalledRuntime(packageRoot, originalLock);
      return;
    }

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
    assert.ok(
      buildInfo !== null,
      "packed CLI dist/build-info.json is malformed",
    );
    assert.deepEqual(
      buildInfo,
      JSON.parse(readFileSync(buildInfoFile, "utf8")),
    );

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
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--install")) {
    process.stderr.write(
      "Usage: node scripts/verify-packed-cli-runtime.js [--install]\n",
    );
    process.exitCode = 1;
  } else {
    verifyPackedRuntime({ install: args[0] === "--install" }).catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
  }
}

module.exports = { verifyInstalledVersions, verifyPackedRuntime };
